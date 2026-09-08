import type { FindingCategory } from "@/lib/tauri";

const RULE_REASONS: Record<string, string> = {
  "credential.pem_private_key": "匹配私钥文件的起止标记和内容结构",
  "auth.authorization_header_bearer": "授权请求头中包含 Bearer 凭据",
  "auth.authorization_header_basic": "授权请求头中包含 Basic 凭据",
  "auth.authorization_header_token": "授权请求头中包含令牌或 API 密钥",
  "auth.bearer": "Bearer 标记后存在符合凭据格式的值",
  "auth.basic": "Basic 标记后存在符合凭据格式的值",
  "token.contextual_secret": "密钥或令牌字段后存在符合凭据格式的值",
  "token.contextual_secret_zh": "中文密钥或令牌字段后存在符合凭据格式的值",
  "token.labeled_app_credential": "应用密钥、加密密钥、令牌或密码字段后存在凭据值",
  "token.env_sensitive_field": "配置字段名以密码、密钥或令牌等敏感词结尾，且包含凭据值",
  "token.custom_sensitive_field": "匹配你添加的敏感字段",
  "credential.database_url": "数据库连接地址中包含用户名和密码",
  "credential.jwt": "匹配 JWT 令牌的三段结构和编码内容",
  "contact.email": "匹配电子邮箱地址格式",
  "contact.phone_context": "电话或手机字段后存在符合电话号码格式的值",
  "identity.cn_mainland_id": "匹配中国大陆身份证号码格式并通过校验",
  "identity.cn_mainland_id_context": "身份证字段后存在证件号码，即使校验位不正确也需确认",
  "financial.bank_card_luhn": "银行卡字段后存在通过校验的卡号",
  "network.ipv4_private": "匹配内网 IPv4 地址格式",
  "network.ipv4_public": "匹配非内网 IPv4 地址格式",
  "token.provider_aws_access_key_id": "匹配 AWS 访问密钥 ID 的前缀和长度",
  "token.provider_github": "匹配 GitHub 令牌的前缀和格式",
  "token.provider_gitlab": "匹配 GitLab 令牌的前缀和格式",
  "token.provider_slack": "匹配 Slack 令牌的前缀和格式",
  "token.provider_slack_webhook": "匹配包含凭据的 Slack Webhook 地址格式",
  "token.provider_stripe": "匹配 Stripe 密钥的前缀和格式",
  "token.provider_google_api_key": "匹配 Google API 密钥的前缀和长度",
  "token.provider_anthropic": "匹配 Anthropic 密钥的前缀和格式",
  "token.provider_openai": "匹配 OpenAI 风格密钥的前缀和格式",
  "token.provider_npm": "匹配 npm 令牌的前缀和长度",
  "token.provider_telegram_bot": "匹配 Telegram 机器人令牌格式",
  "session.cookie_header": "Cookie 请求头或响应头中包含会话内容",
  "session.cookie_field": "Cookie 字段后存在符合会话凭据格式的值",
  "session.explicit_field": "会话标识或会话令牌字段后存在凭据值",
};

const CATEGORY_REASONS: Record<FindingCategory, string> = {
  privateKey: "内容符合私钥识别规则",
  authorization: "内容符合授权凭据识别规则",
  apiKey: "内容符合密钥或凭据识别规则",
  databaseUrl: "内容符合数据库连接凭据识别规则",
  email: "内容符合邮箱识别规则",
  phone: "内容符合电话识别规则",
  nationalId: "内容符合身份证号码识别规则",
  bankCard: "内容符合银行卡号识别规则",
  ipAddress: "内容符合 IP 地址识别规则",
  cookie: "内容符合 Cookie 识别规则",
  session: "内容符合会话凭据识别规则",
};

/** 只使用规则元数据，避免解释中再次泄露命中的原文。 */
export function findingReason(finding: { ruleId: string; category: FindingCategory }): string {
  return (Object.hasOwn(RULE_REASONS, finding.ruleId) ? RULE_REASONS[finding.ruleId] : undefined)
    ?? CATEGORY_REASONS[finding.category]
    ?? "内容符合本地敏感信息识别规则";
}
