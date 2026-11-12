#ifndef TOSKR_NATIVE_KEYCHAIN_HELPER_CONFIG_H
#define TOSKR_NATIVE_KEYCHAIN_HELPER_CONFIG_H

// 只接受 Toskr Native 主程序（同一自签证书）作为调用方
#define TOSKR_CLIENT_REQUIREMENT \
    "identifier \"com.toskr.native\" and certificate leaf = H\"6e960d8b61e1fc9c534e41cb812803d07e85e87b\""
#define TOSKR_DATA_SERVICE @"com.toskr.native"
#define TOSKR_DATA_ACCOUNT @"data-key-v1"
#define TOSKR_HELPER_HELLO "TSKKEY01"
#define TOSKR_HELPER_HELLO_LENGTH 8
#define TOSKR_HELPER_MAX_FRAME (64 * 1024)
#define TOSKR_HELPER_IO_TIMEOUT_SECONDS 5

#endif
