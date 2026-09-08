#import <Foundation/Foundation.h>
#import <Security/Security.h>

static int calls, updates, adds, uiCalls, retrySuccess;
static OSStatus fakeStatus;
static bool uiHistory[8];

static OSStatus fakeUI(Boolean allowed) {
    NSCAssert(uiCalls < 8, @"UI 切换次数必须有界");
    uiHistory[uiCalls] = allowed;
    uiCalls++;
    return errSecSuccess;
}

static OSStatus fakeCopy(CFDictionaryRef query, CFTypeRef *result) {
    (void)query;
    calls++;
    OSStatus status = retrySuccess && calls > 1 ? errSecSuccess : fakeStatus;
    if (status == errSecSuccess) *result = CFDataCreate(NULL, (const UInt8[32]){0}, 32);
    return status;
}

static OSStatus fakeUpdate(CFDictionaryRef query, CFDictionaryRef changes) {
    (void)query;
    (void)changes;
    updates++;
    return fakeStatus;
}

static OSStatus fakeAdd(CFDictionaryRef query, CFTypeRef *result) {
    (void)query;
    (void)result;
    adds++;
    return errSecSuccess;
}

#define SecKeychainSetUserInteractionAllowed fakeUI
#define SecItemCopyMatching fakeCopy
#define SecItemUpdate fakeUpdate
#define SecItemAdd fakeAdd
#define main helper_main
#include "../main.m"
#undef main

static void reset(OSStatus status) {
    calls = updates = adds = uiCalls = retrySuccess = 0;
    memset(uiHistory, 0, sizeof(uiHistory));
    fakeStatus = status;
}

static OSStatus status(NSDictionary *request) {
    return [processRequest(request)[@"status"] intValue];
}

int main(void) {
    @autoreleasepool {
        NSDictionary *load = @{ @"version": @1, @"slot": @"data", @"operation": @"load" };
        reset(errSecSuccess);
        NSCAssert(status(load) == 0 && calls == 1 && uiCalls == 1 && !uiHistory[0], @"读取成功且禁止 UI");
        reset(errSecItemNotFound);
        NSCAssert(status(load) == errSecItemNotFound && adds == 0, @"读取不存在的项不创建密钥");
        reset(errSecInteractionNotAllowed);
        NSCAssert(status(load) == errSecInteractionNotAllowed && calls == 1 && uiCalls == 1 && !uiHistory[0],
            @"默认不请求交互");

        NSMutableDictionary *interactive = [load mutableCopy];
        interactive[@"interactive"] = @YES;
        reset(errSecInteractionNotAllowed);
        retrySuccess = 1;
        NSCAssert(status(interactive) == 0 && calls == 2 && uiCalls == 3 &&
            !uiHistory[0] && uiHistory[1] && !uiHistory[2], @"明确授权后只重试一次并恢复禁止 UI");
        reset(errSecAuthFailed);
        NSCAssert(status(interactive) == errSecAuthFailed && calls == 2 && uiCalls == 3, @"拒绝后不重复请求");

        NSString *encoded = [[NSMutableData dataWithLength:32] base64EncodedStringWithOptions:0];
        NSDictionary *store = @{ @"version": @1, @"slot": @"data", @"operation": @"store", @"value": encoded };
        reset(errSecSuccess);
        NSCAssert(status(store) == 0 && updates == 1 && adds == 0, @"已有项仅更新");
        reset(errSecItemNotFound);
        NSCAssert(status(store) == 0 && updates == 1 && adds == 1, @"确实缺失才新增");
        reset(errSecAuthFailed);
        NSCAssert(status(store) == errSecAuthFailed && updates == 1 && adds == 0, @"权限错误不转为新增");

        NSArray *invalid = @[
            @{ @"version": @YES, @"slot": @"data", @"operation": @"load" },
            @{ @"version": @1, @"slot": @"other", @"operation": @"load" },
            @{ @"version": @1, @"slot": @"data", @"operation": @"delete" },
            @{ @"version": @1, @"slot": @"data", @"operation": @"store", @"value": @"" },
            @{ @"version": @1, @"slot": @"ai", @"operation": @"store", @"value": @"!" },
            @{ @"version": @1, @"slot": @"data", @"operation": @"load", @"interactive": @1 },
            @{ @"version": @1, @"slot": @"data", @"operation": @"load", @"service": @"other" }
        ];
        for (NSDictionary *request in invalid) {
            reset(0);
            NSCAssert(status(request) == errSecParam && calls + updates + adds + uiCalls == 0,
                @"无效协议在钥匙串访问前拒绝");
        }
        puts("✓ 15 项 helper 协议、存储与交互重试测试通过；未访问真实钥匙串");
    }
    return 0;
}
