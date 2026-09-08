#import <Foundation/Foundation.h>

#include <arpa/inet.h>
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static bool exchange(int socket, void *bytes, size_t length, bool writing) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = writing
            ? write(socket, (const uint8_t *)bytes + offset, length - offset)
            : read(socket, (uint8_t *)bytes + offset, length - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return false;
        offset += (size_t)count;
    }
    return true;
}

static int invoke(const char *helper, NSString *operation, bool denied) {
    int sockets[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) != 0) return 1;
    struct timeval timeout = { .tv_sec = 5, .tv_usec = 0 };
    setsockopt(sockets[0], SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(sockets[0], SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_adddup2(&actions, sockets[1], STDIN_FILENO);
    posix_spawn_file_actions_adddup2(&actions, sockets[1], STDOUT_FILENO);
    posix_spawn_file_actions_addclose(&actions, sockets[0]);
    posix_spawn_file_actions_addclose(&actions, sockets[1]);
    pid_t child;
    char *arguments[] = { (char *)helper, NULL };
    int spawned = posix_spawn(&child, helper, &actions, NULL, arguments, environ);
    posix_spawn_file_actions_destroy(&actions);
    close(sockets[1]);
    if (spawned != 0) { close(sockets[0]); return 1; }

    bool completed = false;
    bool receivedResponse = false;
    uint8_t expectedBytes[32];
    memset(expectedBytes, 0x5a, sizeof(expectedBytes));
    NSData *expected = [NSData dataWithBytes:expectedBytes length:sizeof(expectedBytes)];
    char hello[8] = "TSKKEY01", received[8];
    if (exchange(sockets[0], hello, sizeof(hello), true) &&
        exchange(sockets[0], received, sizeof(received), false) && memcmp(hello, received, 8) == 0) {
        NSMutableDictionary *request = [@{
            @"version": @1, @"slot": @"data", @"operation": operation, @"interactive": @NO
        } mutableCopy];
        if ([operation isEqualToString:@"store"]) request[@"value"] = [expected base64EncodedStringWithOptions:0];
        NSData *body = [NSJSONSerialization dataWithJSONObject:request options:0 error:NULL];
        uint32_t length = htonl((uint32_t)body.length);
        if (exchange(sockets[0], &length, sizeof(length), true) &&
            exchange(sockets[0], (void *)body.bytes, body.length, true) &&
            exchange(sockets[0], &length, sizeof(length), false)) {
            length = ntohl(length);
            if (length > 0 && length <= 65536) {
                NSMutableData *response = [NSMutableData dataWithLength:length];
                if (exchange(sockets[0], response.mutableBytes, length, false)) {
                    id parsed = [NSJSONSerialization JSONObjectWithData:response options:0 error:NULL];
                    if ([parsed isKindOfClass:NSDictionary.class]) {
                        receivedResponse = true;
                        completed = [parsed[@"status"] isEqualToNumber:@0];
                        if (completed && [operation isEqualToString:@"load"]) {
                            NSData *value = [[NSData alloc] initWithBase64EncodedString:parsed[@"value"] options:0];
                            completed = [value isEqualToData:expected];
                        }
                        if (!completed) fprintf(stderr, "fixture 返回状态: %d\n", [parsed[@"status"] intValue]);
                    }
                }
            }
        }
    }
    close(sockets[0]);
    int childStatus = 0;
    if (waitpid(child, &childStatus, 0) < 0) return 1;
    if (denied) return !receivedResponse && WIFEXITED(childStatus) && WEXITSTATUS(childStatus) == 1 ? 0 : 1;
    return completed && WIFEXITED(childStatus) && WEXITSTATUS(childStatus) == 0 ? 0 : 1;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        // 两个版本的可执行代码不同，但 identifier、签名证书与 helper 保持相同。
        volatile int revision = TEST_REVISION;
        if (argc != 3 || revision < 1) return 1;
        signal(SIGPIPE, SIG_IGN);
        bool denied = strcmp(argv[2], "expect-denied") == 0;
        NSString *operation = denied ? @"load" : [NSString stringWithUTF8String:argv[2]];
        return invoke(argv[1], operation, denied);
    }
}
