#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <dispatch/dispatch.h>

#include <arpa/inet.h>
#include <bsm/libbsm.h>
#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include "config.h"

// 保持监视器到这个单次请求进程退出，系统授权等待期间也不能留下孤儿进程。
static dispatch_source_t parentExitSource;

static bool watchParentExit(pid_t parent) {
    parentExitSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)parent,
        DISPATCH_PROC_EXIT, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    if (!parentExitSource) return false;
    dispatch_source_set_event_handler(parentExitSource, ^{ _exit(2); });
    dispatch_resume(parentExitSource);
    // 父进程可能恰好在创建监视器前退出，不能只依赖后续的退出事件。
    return getppid() == parent;
}

static int64_t milliseconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int64_t deadline(void) {
    int64_t now = milliseconds();
    return now < 0 ? -1 : now + TOSKR_HELPER_IO_TIMEOUT_SECONDS * 1000;
}

static bool transfer(int fd, void *bytes, size_t length, bool writing, int64_t until) {
    size_t offset = 0;
    while (offset < length) {
        int64_t now = milliseconds();
        if (now < 0 || until <= now) return false;
        struct pollfd pending = { .fd = fd, .events = writing ? POLLOUT : POLLIN };
        int result = poll(&pending, 1, (int)(until - now));
        if (result < 0 && errno == EINTR) continue;
        if (result <= 0 || (pending.revents & (POLLERR | POLLNVAL))) return false;
        ssize_t count = writing
            ? write(fd, (const uint8_t *)bytes + offset, length - offset)
            : read(fd, (uint8_t *)bytes + offset, length - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return false;
        offset += (size_t)count;
    }
    return true;
}

static bool validateTransport(void) {
    struct stat input, output;
    if (fstat(STDIN_FILENO, &input) != 0 || fstat(STDOUT_FILENO, &output) != 0 ||
        !S_ISSOCK(input.st_mode) || !S_ISSOCK(output.st_mode) ||
        input.st_dev != output.st_dev || input.st_ino != output.st_ino) return false;
    int type = 0;
    socklen_t length = sizeof(type);
    if (getsockopt(STDIN_FILENO, SOL_SOCKET, SO_TYPE, &type, &length) != 0 ||
        type != SOCK_STREAM) return false;
    struct sockaddr_un address;
    length = sizeof(address);
    if (getsockname(STDIN_FILENO, (struct sockaddr *)&address, &length) != 0 ||
        address.sun_family != AF_UNIX) return false;
    struct timeval timeout = { .tv_sec = TOSKR_HELPER_IO_TIMEOUT_SECONDS, .tv_usec = 0 };
    return setsockopt(STDIN_FILENO, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0 &&
        setsockopt(STDOUT_FILENO, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) == 0;
}

static bool authenticateClient(pid_t parent) {
    // socketpair 的身份会随对端发送消息刷新，必须在双方交换 hello 后读取。
    char hello[TOSKR_HELPER_HELLO_LENGTH] = TOSKR_HELPER_HELLO;
    char received[TOSKR_HELPER_HELLO_LENGTH];
    int64_t until = deadline();
    if (!transfer(STDOUT_FILENO, hello, sizeof(hello), true, until) ||
        !transfer(STDIN_FILENO, received, sizeof(received), false, until) ||
        memcmp(received, hello, sizeof(hello)) != 0) return false;

    audit_token_t token;
    socklen_t length = sizeof(token);
    if (getsockopt(STDIN_FILENO, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) != 0 ||
        length != sizeof(token) || audit_token_to_pid(token) != parent ||
        audit_token_to_euid(token) != geteuid()) return false;

    NSDictionary *attributes = @{
        (__bridge id)kSecGuestAttributeAudit: [NSData dataWithBytes:&token length:sizeof(token)]
    };
    SecCodeRef code = NULL;
    SecRequirementRef requirement = NULL;
    CFDictionaryRef information = NULL;
    bool accepted = false;
    if (SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attributes,
            kSecCSDefaultFlags, &code) != errSecSuccess ||
        SecRequirementCreateWithString(CFSTR(TOSKR_CLIENT_REQUIREMENT),
            kSecCSDefaultFlags, &requirement) != errSecSuccess ||
        SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement) != errSecSuccess ||
        SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information) != errSecSuccess) {
        goto cleanup;
    }
    {
        NSDictionary *info = (__bridge NSDictionary *)information;
        NSNumber *flags = info[(__bridge id)kSecCodeInfoFlags];
        if (![flags isKindOfClass:NSNumber.class] ||
            !(flags.unsignedIntValue & kSecCodeSignatureRuntime)) goto cleanup;
        id entitlements = info[(__bridge id)kSecCodeInfoEntitlementsDict];
        if (entitlements && ![entitlements isKindOfClass:NSDictionary.class]) goto cleanup;
        NSArray<NSString *> *disallowed = @[
            @"com.apple.security.get-task-allow",
            @"com.apple.security.cs.disable-library-validation",
            @"com.apple.security.cs.allow-dyld-environment-variables",
            @"com.apple.security.cs.disable-executable-page-protection",
            @"com.apple.security.cs.allow-unsigned-executable-memory"
        ];
        for (NSString *key in disallowed) {
            id value = entitlements[key];
            if (value && (![value isKindOfClass:NSNumber.class] || [value boolValue])) goto cleanup;
        }
        accepted = true;
    }
cleanup:
    if (information) CFRelease(information);
    if (requirement) CFRelease(requirement);
    if (code) CFRelease(code);
    return accepted;
}

static NSDictionary *readRequest(void) {
    uint32_t networkLength;
    int64_t until = deadline();
    if (!transfer(STDIN_FILENO, &networkLength, sizeof(networkLength), false, until)) return nil;
    uint32_t length = ntohl(networkLength);
    if (length == 0 || length > TOSKR_HELPER_MAX_FRAME) return nil;
    NSMutableData *frame = [NSMutableData dataWithLength:length];
    if (!transfer(STDIN_FILENO, frame.mutableBytes, length, false, until)) return nil;
    id request = [NSJSONSerialization JSONObjectWithData:frame options:0 error:NULL];
    return [request isKindOfClass:NSDictionary.class] ? request : nil;
}

static bool validValue(NSData *value, bool dataSlot) {
    return dataSlot ? value.length == 32 : value.length > 0 && value.length <= TOSKR_HELPER_MAX_AI_RECORD;
}

static NSMutableDictionary *itemQuery(bool dataSlot, bool interactive) {
    return [@{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: dataSlot ? @"com.toskr.app.data" : @"com.toskr.app.ai",
        (__bridge id)kSecAttrAccount: dataSlot ? @"data-encryption-key-v1" : @"openai-compatible",
        (__bridge id)kSecUseDataProtectionKeychain: @NO,
        (__bridge id)kSecUseAuthenticationUI: (__bridge id)(interactive
            ? kSecUseAuthenticationUIAllow : kSecUseAuthenticationUIFail)
    } mutableCopy];
}

static OSStatus performOperation(bool dataSlot, bool storing, NSData *value,
                                 bool interactive, NSData *__autoreleasing *loaded) {
    NSMutableDictionary *query = itemQuery(dataSlot, interactive);
    if (!storing) {
        query[(__bridge id)kSecReturnData] = @YES;
        query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
        CFTypeRef result = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
        if (status == errSecSuccess) {
            if (!result || CFGetTypeID(result) != CFDataGetTypeID() ||
                !validValue((__bridge NSData *)result, dataSlot)) {
                status = errSecDecode;
            } else {
                *loaded = [(__bridge NSData *)result copy];
            }
        }
        if (result) CFRelease(result);
        return status;
    }

    NSDictionary *changes = @{ (__bridge id)kSecValueData: value };
    OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)changes);
    if (status != errSecItemNotFound) return status;
    // 只在确实不存在时新增，已有项不删除、不重建、不扩大 ACL。
    query[(__bridge id)kSecValueData] = value;
    status = SecItemAdd((__bridge CFDictionaryRef)query, NULL);
    if (status == errSecDuplicateItem) {
        [query removeObjectForKey:(__bridge id)kSecValueData];
        status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)changes);
    }
    return status;
}

static NSDictionary *processRequest(NSDictionary *request) {
    NSSet *allowed = [NSSet setWithArray:@[@"version", @"slot", @"operation", @"value", @"interactive"]];
    for (id key in request) {
        if (![allowed containsObject:key]) return @{ @"status": @(errSecParam) };
    }
    id version = request[@"version"];
    id interactive = request[@"interactive"];
    id slot = request[@"slot"];
    id operation = request[@"operation"];
    if (![version isKindOfClass:NSNumber.class] ||
        CFGetTypeID((__bridge CFTypeRef)version) == CFBooleanGetTypeID() ||
        ![version isEqualToNumber:@1] ||
        (interactive && CFGetTypeID((__bridge CFTypeRef)interactive) != CFBooleanGetTypeID()) ||
        ![slot isKindOfClass:NSString.class] ||
        (![slot isEqualToString:@"data"] && ![slot isEqualToString:@"ai"]) ||
        ![operation isKindOfClass:NSString.class] ||
        (![operation isEqualToString:@"load"] && ![operation isEqualToString:@"store"])) {
        return @{ @"status": @(errSecParam) };
    }
    bool dataSlot = [slot isEqualToString:@"data"];
    bool storing = [operation isEqualToString:@"store"];
    NSData *value = nil;
    if (storing) {
        id encoded = request[@"value"];
        if (![encoded isKindOfClass:NSString.class]) return @{ @"status": @(errSecParam) };
        value = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
        if (!value || !validValue(value, dataSlot)) return @{ @"status": @(errSecParam) };
    } else if (request[@"value"]) {
        return @{ @"status": @(errSecParam) };
    }

    NSData *loaded = nil;
    OSStatus status = SecKeychainSetUserInteractionAllowed(false);
    if (status != errSecSuccess) return @{ @"status": @(status) };
    status = performOperation(dataSlot, storing, value, false, &loaded);
    if ([interactive boolValue] && (status == errSecInteractionNotAllowed ||
        status == errSecInteractionRequired || status == errSecAuthFailed)) {
        OSStatus allowedStatus = SecKeychainSetUserInteractionAllowed(true);
        status = allowedStatus == errSecSuccess
            ? performOperation(dataSlot, storing, value, true, &loaded) : allowedStatus;
        SecKeychainSetUserInteractionAllowed(false);
    }
    if (status == errSecSuccess && !storing) {
        return @{ @"status": @(status), @"value": [loaded base64EncodedStringWithOptions:0] };
    }
    return @{ @"status": @(status) };
}

static bool sendResponse(NSDictionary *response) {
    NSData *frame = [NSJSONSerialization dataWithJSONObject:response options:0 error:NULL];
    if (!frame || frame.length > TOSKR_HELPER_MAX_FRAME) return false;
    uint32_t networkLength = htonl((uint32_t)frame.length);
    int64_t until = deadline();
    return transfer(STDOUT_FILENO, &networkLength, sizeof(networkLength), true, until) &&
        transfer(STDOUT_FILENO, (void *)frame.bytes, frame.length, true, until);
}

int main(int argc, const char *argv[]) {
    (void)argv;
    @autoreleasepool {
        pid_t parent = getppid();
        signal(SIGPIPE, SIG_IGN);
        if (argc != 1 || !validateTransport() || !watchParentExit(parent) ||
            !authenticateClient(parent)) {
            fputs("Toskr keychain helper: authentication failed\n", stderr);
            return 1;
        }
        NSDictionary *request = readRequest();
        if (!request || !sendResponse(processRequest(request))) {
            fputs("Toskr keychain helper: protocol failed\n", stderr);
            return 1;
        }
        return 0;
    }
}
