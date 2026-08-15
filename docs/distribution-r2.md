# 自有域名 + Cloudflare R2 分发设置指南

发行产物（DMG / updater tar.gz / 签名 / latest.json）托管在 Cloudflare R2 桶，
经自有子域（下文以 `dl.example.com` 占位）对外提供下载与自动更新。
R2 出站流量免费、免费额度 10GB 存储，本项目体量下成本≈0。
当前处于**双发过渡期**：`release.sh` 同时发 R2 与 GitHub Releases，
待存量用户升级到含新端点的版本后，`PUBLISH_GITHUB=0` 即可切仅 R2。

## 一次性设置清单（Cloudflare 控制台）

1. **接入域名**：Cloudflare 注册/登录（Free 计划够用）→ Add site 添加你的域名 →
   按提示到域名注册商把 NS 记录切到 Cloudflare 分配的两个 NS。
   生效通常几分钟，最长 48h；Cloudflare 站点状态变为 Active 才能进行第 3 步。
2. **启用 R2**：控制台左栏 R2 → 首次启用需绑一张支付卡（免费额度内不扣费）→
   Create bucket，命名 `toskr-releases`（与 release.sh 里 `R2_BUCKET` 一致），位置 Automatic。
3. **绑定自定义域**：桶 → Settings → Custom Domains → Connect Domain →
   填 `dl.<你的域名>`（会自动创建一条代理 DNS 记录）。
   ⚠️ 不要用 `*.r2.dev` 公共开发子域做生产分发/更新端点——限速且不承诺可用性。
4. **创建 API Token**（给 wrangler 上传用）：右上角头像 → My Profile → API Tokens →
   Create Token → Custom token：权限选 `Account → Workers R2 Storage → Edit`，
   Account Resources 限定本账号。创建后复制 token；
   Account ID 在控制台任意页面右栏（或 R2 概览页）可见。
5. **本机凭据文件**（绝不入 Git，红线同 `~/.tauri/toskr-updater.key`）：

   ```bash
   mkdir -p ~/.config/toskr
   cat > ~/.config/toskr/r2-release.env <<'EOF'
   export CLOUDFLARE_ACCOUNT_ID=你的AccountID
   export CLOUDFLARE_API_TOKEN=你的Token
   EOF
   chmod 600 ~/.config/toskr/r2-release.env
   ```

6. **替换占位符**为真实子域（如 `dl.example.com` → `dl.yourdomain.com`）：
   - `script/release.sh` 的 `PUBLIC_BASE`
   - `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints[0]`
   - README 的下载入口届时也可改为稳定直链 `https://dl.<你的域名>/Toskr.dmg`（双发期 GitHub 链接仍有效，不急）
7. **冒烟验证**（项目根目录）：

   ```bash
   source ~/.config/toskr/r2-release.env
   echo smoke > /tmp/r2-smoke.txt
   pnpm exec wrangler r2 object put toskr-releases/r2-smoke.txt --file /tmp/r2-smoke.txt --remote
   curl -fsS https://dl.<你的域名>/r2-smoke.txt   # 应输出 smoke
   pnpm exec wrangler r2 object delete toskr-releases/r2-smoke.txt --remote
   ```

## 对象布局与缓存策略（release.sh 自动维护）

| 对象 key | 用途 | Cache-Control |
|---|---|---|
| `latest.json` | updater 端点清单 | `public, max-age=60, must-revalidate` |
| `Toskr.dmg` | 稳定下载直链（给人类/官网） | `public, max-age=300` |
| `releases/v<ver>/Toskr_<ver>_aarch64.dmg` | 版本化 DMG | `public, max-age=31536000, immutable` |
| `releases/v<ver>/Toskr.app.tar.gz` + `.sig` | updater 下载包与签名 | 同上 |

上传顺序：产物先传、`latest.json` 最后传，杜绝「清单已指新版、包还没就位」的窗口。
发布后脚本自动核验：远端清单版本号/签名与本地一致、远端 tar.gz 大小与本地一致。

## 渠道开关

```bash
./script/release.sh 0.18.0 "说明"                  # 默认：R2 + GitHub 双发
PUBLISH_R2=0 ./script/release.sh 0.18.0 "说明"     # 仅 GitHub（R2/域名尚未就绪时）
PUBLISH_GITHUB=0 ./script/release.sh 0.18.0 "说明" # 仅 R2（过渡结束后）
```

更新器端点顺序为 `[R2, GitHub]`：双发期两边清单都新鲜；将来停发 GitHub 后，
其陈旧清单版本号不再更高、自然失效，无需再改端点。
若将仓库转 private（闭源），GitHub 渠道资产即刻对外 404，等效停发——届时固定 `PUBLISH_GITHUB=0`。

## 故障排查

- **绑定域名后访问 522/1016**：NS 切换未生效或站点未 Active，先等 DNS 收敛
- **wrangler 报 10041 / Authentication error**：token 权限不是 `Workers R2 Storage: Edit`，或 Account ID 不匹配
- **latest.json 拉到旧版本**：边缘缓存最长 60 秒；脚本验证已带时间戳参绕过，手工核验可加 `?ts=$(date +%s)`
- **更新器提示签名校验失败**：`.sig` 与 tar.gz 不是同一次构建的产物；重跑 release.sh 整体重传
- **中国大陆访问慢**：Cloudflare 免费计划国际节点可达但速度波动，属已知情况，无需配置
