export type SettingsSectionId =
  | "general"
  | "hotkey"
  | "clip"
  | "features"
  | "message-watch"
  | "secret"
  | "target"
  | "outcome"
  | "due"
  | "ai"
  | "companion"
  | "data"
  | "diagnostics"
  | "about";

export type SettingsSearchGates = {
  messagesEnabled: boolean;
  secretEnabled: boolean;
  subscriptionsEnabled: boolean;
};

type SettingsSearchGate = keyof SettingsSearchGates;

export type SettingsSearchEntry = {
  id: string;
  section: SettingsSectionId;
  title: string;
  keywords?: readonly string[];
  /** 点击结果后优先滚动到的 Row / Group / SectionTitle 文案。 */
  target?: string;
  requires?: SettingsSearchGate;
};

export const SETTINGS_SECTION_LABELS: Record<SettingsSectionId, string> = {
  general: "通用",
  hotkey: "捕获与快捷键",
  clip: "剪贴板",
  features: "功能开关",
  "message-watch": "消息监听",
  secret: "秘文",
  target: "目标与发送方案",
  outcome: "使用概览",
  due: "到期提醒",
  ai: "AI 智能",
  companion: "伴随停靠",
  data: "数据",
  diagnostics: "诊断",
  about: "关于",
};

const entry = (
  section: SettingsSectionId,
  id: string,
  title: string,
  keywords: readonly string[] = [],
  options: Pick<SettingsSearchEntry, "target" | "requires"> = {}
): SettingsSearchEntry => ({ section, id, title, keywords, ...options });

/**
 * 只索引设置名称和稳定别名，不抓 DOM、路径、密钥或诊断等运行态值。
 * 功能域内部项带 gate；总开关本身始终可搜，关闭时仍有明确开启入口。
 */
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  entry("general", "general", "通用", ["偏好", "设置"]),
  entry("general", "tour", "新手导览", ["教程", "首次启动", "重看", "welcome", "tour"]),
  entry("general", "theme", "主题", ["外观", "浅色", "深色", "跟随系统", "theme"]),
  entry("general", "window-opacity", "窗口整体不透明度", ["透明", "窗口", "opacity"]),
  entry("general", "panel-opacity", "内容底色浓度", ["面板", "膜层", "透明度"]),
  entry("general", "vibrancy", "毛玻璃背景", ["模糊", "vibrancy", "macos"]),
  entry("general", "vibrancy-style", "毛玻璃风格", ["通透", "柔和", "厚重", "vibrancy"], { target: "毛玻璃背景" }),
  entry("general", "card-tint", "卡片彩色通栏", ["颜色", "来源应用", "分组色"]),
  entry("general", "card-density", "卡片密度", ["舒适", "紧凑", "单行"]),
  entry("general", "clip-template", "剪贴卡模板", ["标准", "浓缩", "摘要"], { target: "卡片密度" }),
  entry("general", "card-opacity", "卡片底色不透明度", ["卡片透明", "毛玻璃"]),
  entry("general", "detail-font", "详情窗字号", ["字体", "文字大小", "font", "cmd+", "cmd-"]),
  entry("general", "autostart", "开机启动", ["登录启动", "后台待命", "launch"]),
  entry("general", "topmost", "面板置顶", ["最上层", "窗口"]),
  entry("general", "hide-blur", "失焦自动隐藏", ["自动收起", "点击其他应用"]),
  entry("general", "stealth", "隐身模式", ["投屏", "会议", "静默", "气泡"]),
  entry("general", "sound", "音效", ["声音", "提示音"]),
  entry("general", "hud-duration", "提示显示时长", ["hud", "气泡", "持续时间"]),
  entry("general", "context-menu", "卡片右键菜单", ["菜单", "合并", "回复", "删除"], {
    target: "卡片右键菜单（勾选显示 · 组内调序；合并、回复关系与删除固定）",
  }),

  entry("companion", "companion", "伴随停靠", ["磁吸", "跟随窗口", "停靠"]),
  entry("companion", "companion-enabled", "启用伴随停靠", ["打开停靠", "磁吸"]),
  entry("companion", "companion-gap", "与窗口的间隙", ["距离", "边距", "gap"]),

  entry("features", "features", "功能开关", ["启用功能", "实验功能", "默认关闭"]),
  entry("features", "feature-message", "消息监听（实验）", ["开启消息", "im", "只读监听"], { target: "消息监听（实验）" }),
  entry("features", "feature-secret", "秘文", ["开启秘文", "加密", "密钥"]),
  entry("features", "feature-subscriptions", "订阅", ["开启订阅", "账单", "信用卡"]),

  entry("hotkey", "hotkey", "捕获与快捷键", ["键盘", "热键", "hotkey", "shortcut", "shift"]),
  entry("hotkey", "trigger-key", "触发键（双击）", ["双击 shift", "捕获键", "全局触发"]),
  entry("hotkey", "double-interval", "双击间隔", ["速度", "毫秒", "触发间隔"]),
  entry("hotkey", "double-action", "双击行为", ["划词", "显示面板", "捕获行为"]),
  entry("hotkey", "panel-toggle", "面板显示 / 隐藏", ["打开面板", "关闭面板", "快捷键"]),
  entry("hotkey", "panel-shortcuts", "面板内快捷键", ["alt", "option", "速查", "键盘操作"], {
    target: "面板内快捷键（长按 ⌥ 可随时速查）",
  }),
  entry("hotkey", "exclude-apps", "忽略应用", ["排除应用", "不捕获", "exclude"]),

  entry("clip", "clipboard", "剪贴板", ["复制", "历史", "clipboard"]),
  entry("clip", "clipboard-history", "剪贴板历史", ["收集复制内容", "开启历史"]),
  entry("clip", "pause-capture", "暂停收集", ["临时关闭", "停止记录"], { target: "剪贴板历史" }),
  entry("clip", "double-copy-pin", "连续复制两次自动置顶", ["重复复制", "置顶"], { target: "剪贴板历史" }),
  entry("clip", "retention", "保留时长", ["历史期限", "自动删除"]),
  entry("clip", "delete-history", "删除历史", ["清空剪贴板", "清理"]),
  entry("clip", "ignore-secret", "忽略机密内容", ["密码", "敏感剪贴板", "机密"]),
  entry("clip", "ignore-transient", "忽略瞬时内容", ["临时剪贴板", "一次性"]),
  entry("clip", "capture-rules", "收集规则与忽略应用", ["过滤", "排除应用", "规则"]),

  entry("message-watch", "message-watch", "消息监听", ["im", "群消息", "只读监听"], { requires: "messagesEnabled" }),
  entry("message-watch", "watch-target", "监听目标", ["im 软件", "应用探测", "确认应用"], { requires: "messagesEnabled" }),
  entry("message-watch", "watch-auto", "自动接入（推荐）", ["cdp", "自动监听", "devtools"], { target: "监听目标", requires: "messagesEnabled" }),
  entry("message-watch", "watch-manual", "手动模式（备选）", ["端口", "手动监听", "websocket"], { target: "监听目标", requires: "messagesEnabled" }),
  entry("message-watch", "watch-bridge", "安装 DevTools 只读桥", ["浏览器桥", "runtime binding"], { target: "监听目标", requires: "messagesEnabled" }),
  entry("message-watch", "watch-rules", "消息监听规则", ["@我", "特别关注", "关键词", "群名", "发送者"], { target: "收哪些消息", requires: "messagesEnabled" }),
  entry("message-watch", "watch-ledger", "消息数据存储", ["账本", "jsonl", "原始消息"], { target: "数据存储", requires: "messagesEnabled" }),

  entry("secret", "secret", "秘文", ["加密", "解密"], { requires: "secretEnabled" }),
  entry("secret", "secret-keys", "共享密钥", ["密钥管理", "key", "密码"], { requires: "secretEnabled" }),
  entry("secret", "secret-remask", "揭示后自动遮罩", ["重新遮罩", "隐藏明文", "自动打码"], { requires: "secretEnabled" }),
  entry(
    "secret",
    "secret-style",
    "默认密文格式",
    [
      "密文外观",
      "中文",
      "中文文本",
      "代码风格",
      "随机代码",
      "随机语言",
      "javascript",
      "python",
      "go",
      "rust",
      "日志格式",
      "引用格式",
      "自动识别",
      "支持该格式",
      "无需选择类型",
      "样式",
      "排版",
    ],
    { requires: "secretEnabled" }
  ),

  entry("target", "target", "目标与发送方案", ["发送对象", "应用方案", "profile"]),
  entry("target", "profiles", "发送方案", ["目标应用", "应用分配", "默认方案"], { target: "目标与发送方案" }),
  entry("target", "output-format", "输出格式", ["纯文本", "markdown", "格式化"], { target: "目标与发送方案" }),
  entry("target", "enter-policy", "粘贴后动作", ["回车", "自动发送", "仅粘贴"], { target: "目标与发送方案" }),
  entry("target", "aliases", "隐私与化名", ["可逆化名", "词典", "恢复原文"]),
  entry("target", "prompt-groups", "提示词组", ["prompt", "模板", "提示词"]),
  entry("target", "firewall", "发送前隐私检查", ["敏感内容", "本机检查", "防火墙", "privacy"], { target: "发送前隐私检查（仅本机文本检查）" }),
  entry("target", "firewall-enabled", "启用隐私检查", ["快速发送检查", "预检"]),
  entry("target", "firewall-categories", "提示级类别", ["身份证", "手机号", "地址", "敏感类别"], { target: "发送前隐私检查（仅本机文本检查）" }),

  entry("outcome", "outcome", "使用概览", ["统计", "发送记录", "本机数据"]),
  entry("outcome", "learning", "安全发送入门", ["演练", "教程", "恢复教学"], { target: "使用概览" }),
  entry("outcome", "success-rate", "发送成功率", ["完成次数", "失败", "受阻"], { target: "使用概览" }),
  entry("outcome", "timing", "发送用时", ["准备到发送", "完整流程", "节省时间"], { target: "使用概览" }),
  entry("outcome", "privacy-metrics", "敏感内容保护", ["已保护", "隐私检查", "redaction"], { target: "使用概览" }),
  entry("outcome", "details", "趋势和详细数据", ["每日变化", "筛选", "高级工具"], { target: "使用概览" }),

  entry("due", "due", "到期提醒", ["任务提醒", "deadline", "日期"]),
  entry("due", "due-presets", "到期提醒快捷档", ["多久后", "今天", "明天", "下个周几"]),
  entry("due", "relative-due", "相对提醒时间", ["分钟", "小时", "多久后"], { target: "到期提醒快捷档" }),
  entry("due", "bill-reminders", "账单到期提醒", ["订阅", "信用卡", "提前提醒"], { requires: "subscriptionsEnabled" }),
  entry("due", "currency", "金额货币符号", ["人民币", "美元", "币种", "currency"], { target: "账单到期提醒", requires: "subscriptionsEnabled" }),

  entry("ai", "ai", "AI 智能", ["模型", "人工智能", "llm"]),
  entry("ai", "ai-enabled", "启用 AI 智能", ["打开 ai", "智能功能"]),
  entry("ai", "provider", "提供商（OpenAI 兼容）", ["openai", "服务商", "provider"]),
  entry("ai", "base-url", "Base URL", ["接口地址", "endpoint", "api 地址"], { target: "启用 AI 智能" }),
  entry("ai", "api-key", "API Key", ["密钥", "token", "凭据"], { target: "启用 AI 智能" }),
  entry("ai", "model", "模型名", ["model", "模型选择"], { target: "启用 AI 智能" }),
  entry("ai", "connection", "连接测试", ["测试 ai", "连通性"], { target: "启用 AI 智能" }),

  entry("data", "data", "数据", ["本地存储", "无同步", "无遥测"]),
  entry("data", "data-folder", "数据文件夹", ["存储位置", "数据目录", "路径"], { target: "存储位置" }),
  entry("data", "switch-folder", "切换数据目录", ["迁移", "加载目录", "icloud", "dropbox"], { target: "存储位置" }),
  entry("data", "storage-recovery", "数据目录恢复", ["只读", "挂载失败", "默认目录", "冲突"], { target: "存储位置" }),
  entry("data", "export", "导出完整备份", ["备份", "backup", "export", "manifest"]),
  entry("data", "import", "导入并预检", ["恢复备份", "backup", "import", "json"]),
  entry("data", "health", "数据健康", ["媒体检查", "缺失文件", "孤立文件", "gc"]),

  entry("diagnostics", "diagnostics", "诊断", ["日志", "排错", "事件"]),
  entry("diagnostics", "capture-diagnostics", "捕获诊断", ["双击触发", "拒绝原因", "捕获分支"], { target: "诊断" }),
  entry("diagnostics", "delivery-diagnostics", "发送诊断", ["发送结果", "目标", "失败原因"], { target: "诊断" }),

  entry("about", "about", "关于", ["版本", "version", "toskr"]),
  entry("about", "check-update", "检查更新", ["新版本", "升级", "update"], { target: "更新" }),
  entry("about", "auto-check", "自动检查更新", ["启动检查", "静默检查"]),
  entry("about", "auto-install", "自动安装更新", ["后台下载", "重启生效"]),
  entry("about", "changelog", "更新日志", ["版本记录", "release notes"], { target: "更新" }),
  entry("about", "homepage", "项目主页", ["github", "仓库"], { target: "链接" }),
  entry("about", "bug", "报告 Bug", ["issue", "反馈问题", "错误"], { target: "链接" }),
];

export function normalizeSettingsSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\-_/]+/g, "");
}

export function searchSettings(
  query: string,
  gates: SettingsSearchGates
): SettingsSearchEntry[] {
  const normalizedQuery = normalizeSettingsSearchText(query.trim());
  if (!normalizedQuery) return [];
  const tokens = query
    .trim()
    .split(/\s+/)
    .map(normalizeSettingsSearchText)
    .filter(Boolean);

  return SETTINGS_SEARCH_ENTRIES
    .map((item, index) => {
      if (item.requires && !gates[item.requires]) return null;
      const title = normalizeSettingsSearchText(item.title);
      const section = normalizeSettingsSearchText(SETTINGS_SECTION_LABELS[item.section]);
      const keywords = (item.keywords ?? []).map(normalizeSettingsSearchText);
      const fields = [title, section, ...keywords];
      if (!tokens.every((token) => fields.some((field) => field.includes(token)))) {
        return null;
      }
      const score = title === normalizedQuery
        ? 0
        : title.startsWith(normalizedQuery)
          ? 1
          : title.includes(normalizedQuery)
            ? 2
            : section === normalizedQuery
              ? 3
              : section.includes(normalizedQuery)
                ? 4
                : keywords.some((keyword) => keyword === normalizedQuery)
                  ? 5
                  : 6;
      return { item, score, index };
    })
    .filter((result): result is {
      item: SettingsSearchEntry;
      score: number;
      index: number;
    } => result !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ item }) => item);
}
