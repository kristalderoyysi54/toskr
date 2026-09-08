#import <Foundation/Foundation.h>
#import <Security/Security.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) return 1;
        NSString *service = [NSString stringWithUTF8String:argv[1]];
        NSString *account = [NSString stringWithUTF8String:argv[2]];
        NSRegularExpression *pattern = [NSRegularExpression
            regularExpressionWithPattern:@"^com\\.toskr\\.test\\.helper\\.[a-f0-9]{32}\\.(data|ai)$"
            options:0 error:NULL];
        if ([pattern numberOfMatchesInString:service options:0 range:NSMakeRange(0, service.length)] != 1 ||
            ![account isEqualToString:[service hasSuffix:@".data"]
                ? @"data-encryption-key-v1" : @"openai-compatible"]) return 1;
        OSStatus status = SecKeychainSetUserInteractionAllowed(false);
        if (status != errSecSuccess) return 1;
        // 仅取条目引用，不请求密码长度或密码内容；随后删除本轮 UUID 项。
        SecKeychainItemRef item = NULL;
        status = SecKeychainFindGenericPassword(NULL, (UInt32)strlen(service.UTF8String), service.UTF8String,
            (UInt32)strlen(account.UTF8String), account.UTF8String, NULL, NULL, &item);
        if (status == errSecSuccess) status = SecKeychainItemDelete(item);
        if (item) CFRelease(item);
        if (status == errSecSuccess || status == errSecItemNotFound) return 0;
        fprintf(stderr, "临时项目清理状态: %d\n", (int)status);
        return 1;
    }
}
