# 内置密钥辅助程序

正式版的数据加密密钥与 AI 密钥记录通过 `Toskr.app/Contents/Helpers/toskr-keychain-helper` 访问。用户只安装 Toskr，不另装应用。两类密钥仍是登录钥匙串中的独立条目，服务名、账户名、数据格式和 AI 删除标记均不变。

普通版本更新复用同一份已签名辅助程序，避免主程序每次构建的代码指纹变化影响钥匙串访问。首次访问原有条目仍可能分别需要用户授权；钥匙串锁定、授权撤销或辅助程序本身升级时也可能需要再次授权。这里不承诺系统永不提示。

## 访问边界

- 主程序与辅助程序通过匿名 Unix socket 对交换 hello 后，以内核 audit token 验证对端身份；主程序还检查子进程 PID、UID、证书、identifier 和清单锁定的 CDHash。
- 辅助程序只接受相同 UID 的本次父进程，验证固定主程序证书及 identifier，要求 hardened runtime，拒绝调试与代码注入权限。
- 只有认证完成才传输请求或访问钥匙串。每次进程只接受一项请求，槽位仅限 `data` 和 `ai`，不接受任意钥匙串服务名。
- 所有查询先禁止系统 UI；遇到需要授权的错误且本次允许交互时，只重试一次。取消不会进入自动循环。
- 数据密钥与成功读取的 AI 记录只在 Rust 进程内缓存。AI 显式保存、删除成功后更新缓存；失败不会被缓存成“不存在”。AI 旧配置迁移只在实际使用 AI 或进入 AI 设置时进行。
- 发布版辅助程序缺失或身份不符会拒绝访问，不回退到主进程再次索取授权。`tauri dev` 的调试构建没有正式签名，沿用原开发钥匙串路径，不能用于升级免重复授权验收。

## 固定产物与构建

`src-tauri/keychain-helper/artifacts/toskr-keychain-helper` 是已签名的 arm64/x86_64 通用产物，与源码和 `manifest.json` 一同版本化。清单记录源码 SHA-256、产物 SHA-256 与各架构 CDHash；不包含私钥。

普通构建只校验并复制产物，不编译或重签辅助程序：

```sh
python3 script/keychain-helper.py check
pnpm build:app
```

Tauri 的 `bundle.macOS.files` 把它放入 `Contents/Helpers`，避免 externalBin 的自动重签路径。`build:app` 与 `release.sh` 在打包后检查包内副本逐字节一致；任何偏差阻止交付。

只有审查过辅助程序本身的升级才运行：

```sh
python3 script/keychain-helper.py build
```

这会重新编译、签名并更新清单，可能使存量用户再次授权；不得作为普通打包前置命令。变更签名证书时需同步双方身份要求并独立规划迁移。由于 Rust 编译时嵌入清单，必须重新构建主程序。

## 验收

除了前端/Rust 回归，运行辅助程序的模拟协议测试及隔离原生升级测试。原生测试只使用唯一命名的合成钥匙串条目，并在结束时删除；禁止用用户真实密钥做测试或输出它们。

```sh
python3 script/test-keychain-helper.py
python3 script/test-keychain-helper-native.py
```

发布验收包括：两份不同主程序构建共用相同辅助程序后正常读取；错误签名、错误 identifier、非 hardened 调用者被拒绝；取消授权不新建数据密钥、不恢复已删除 AI key；包内辅助程序与锁定产物一致。

当前最低系统版本为 macOS 13；跨架构编译不等于 Intel 或 macOS 13 真机验收。
