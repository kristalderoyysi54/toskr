//! OpenAI 兼容 AI 传输边界。
//!
//! API key 只存在 macOS Keychain 与 Rust 进程内存，不进入 WebView 状态、
//! 进程参数或诊断日志。HTTP 使用进程内 reqwest；远端只允许 HTTPS，HTTP 仅允许
//! 精确 loopback。响应错误只返回状态级信息，不回显 provider body。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::privacy::{CustomSensitiveRules, FindingCategory, ScanSensitiveRequest};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::watch;
use url::{Host, Url};

const AI_KEY_STATUS_EVENT: &str = "toskr://ai-key-status";
const MAX_KEY_BYTES: usize = 8 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

static KEYCHAIN_LOCK: Mutex<()> = Mutex::new(());
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

struct AiRequestState {
    owner: String,
    cancel: watch::Sender<bool>,
    phase: AiRequestPhase,
    created: Instant,
}

enum AiRequestPhase {
    Prepared,
    Authorizing,
    Authorized(AiGrant),
    Running,
}

struct AiGrant {
    binding: AiBinding,
    issued: Instant,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AiBinding {
    endpoint: String,
    purpose: AiPurpose,
    payload_hash: [u8; 32],
    policy_hash: [u8; 32],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiPurpose {
    CreateTask,
    SplitSubtasks,
    NoteToTask,
    SuggestTitle,
    TestConnection,
    MessageDraft,
    ResultVerification,
    Summarize,
    ExtractActions,
    ImprovePrompt,
    StructureRequirements,
}

impl AiPurpose {
    fn label(self) -> &'static str {
        match self {
            Self::CreateTask => "创建任务",
            Self::SplitSubtasks => "拆解子任务",
            Self::NoteToTask => "笔记转任务",
            Self::SuggestTitle => "生成标题",
            Self::TestConnection => "测试 AI 连接",
            Self::MessageDraft => "生成消息回复",
            Self::ResultVerification => "结果核验",
            Self::Summarize => "总结要点",
            Self::ExtractActions => "提取行动项",
            Self::ImprovePrompt => "优化 Prompt",
            Self::StructureRequirements => "结构化需求",
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiPayload {
    base_url: String,
    model: String,
    system: String,
    user: String,
    max_tokens: u32,
    purpose: AiPurpose,
}

fn ai_binding(payload: &AiPayload, rules: &CustomSensitiveRules) -> Result<AiBinding, String> {
    if payload.system.len() > crate::privacy::MAX_SCAN_INPUT_BYTES
        || payload.user.len() > crate::privacy::MAX_SCAN_INPUT_BYTES
    {
        return Err("AI 请求超过隐私检查上限，未发送".into());
    }
    let endpoint = build_ai_endpoint(&payload.base_url, "v1/chat/completions")?;
    let payload_bytes = serde_json::to_vec(&(
        &payload.model,
        &payload.system,
        &payload.user,
        payload.max_tokens,
    ))
    .map_err(|_| "无法核验 AI 请求")?;
    let policy_bytes =
        serde_json::to_vec(&(1u32, crate::privacy::FIREWALL_RULE_VERSION, &rules.fields))
            .map_err(|_| "无法核验 AI 隐私规则")?;
    Ok(AiBinding {
        endpoint: endpoint.to_string(),
        purpose: payload.purpose,
        payload_hash: Sha256::digest(payload_bytes).into(),
        policy_hash: Sha256::digest(policy_bytes).into(),
    })
}

fn ai_sensitive_summary(
    payload: &AiPayload,
    rules: &CustomSensitiveRules,
) -> Result<Vec<String>, String> {
    let mut counts = std::collections::BTreeMap::<&str, usize>::new();
    for text in [&payload.system, &payload.user] {
        let scan = crate::privacy::scan_sensitive_text_with_rules(
            ScanSensitiveRequest { text: text.clone() },
            rules,
        );
        if !scan.complete || !scan.warnings.is_empty() {
            return Err("隐私检查未完整覆盖 AI 请求，未发送".into());
        }
        for finding in scan.findings {
            let label = match finding.category {
                FindingCategory::PrivateKey => "私钥",
                FindingCategory::Authorization => "授权凭据",
                FindingCategory::ApiKey => "密钥或敏感字段",
                FindingCategory::DatabaseUrl => "数据库地址",
                FindingCategory::Email => "邮箱",
                FindingCategory::Phone => "电话号码",
                FindingCategory::NationalId => "身份证号",
                FindingCategory::BankCard => "银行卡号",
                FindingCategory::IpAddress => "IP 地址",
                FindingCategory::Cookie => "Cookie",
                FindingCategory::Session => "会话标识",
            };
            *counts.entry(label).or_default() += 1;
        }
    }
    Ok(counts
        .into_iter()
        .map(|(label, count)| format!("{label} {count} 处"))
        .collect())
}

#[derive(Default)]
struct AiRequests {
    sequence: AtomicU64,
    entries: Mutex<HashMap<String, AiRequestState>>,
}

static AI_REQUESTS: OnceLock<AiRequests> = OnceLock::new();

impl AiRequests {
    fn prepare(&self, owner: &str) -> Result<String, String> {
        let mut entries = self.entries.lock().map_err(|_| "AI 请求状态不可用")?;
        entries.retain(|_, entry| {
            matches!(entry.phase, AiRequestPhase::Running)
                || entry.created.elapsed() < Duration::from_secs(60)
        });
        if entries.len() >= 64 {
            return Err("AI 请求过多，请稍后重试".into());
        }
        let id = format!("ai-{}", self.sequence.fetch_add(1, Ordering::Relaxed));
        let (cancel, _) = watch::channel(false);
        entries.insert(
            id.clone(),
            AiRequestState {
                owner: owner.to_string(),
                cancel,
                phase: AiRequestPhase::Prepared,
                created: Instant::now(),
            },
        );
        Ok(id)
    }

    fn begin_authorization(&self, owner: &str, id: &str) -> Result<watch::Receiver<bool>, String> {
        let mut entries = self.entries.lock().map_err(|_| "AI 请求状态不可用")?;
        let entry = entries.get_mut(id).ok_or("AI 请求已取消或失效")?;
        if entry.owner != owner
            || !matches!(entry.phase, AiRequestPhase::Prepared)
            || entry.created.elapsed() >= Duration::from_secs(60)
        {
            return Err("AI 请求已取消或失效".into());
        }
        entry.phase = AiRequestPhase::Authorizing;
        Ok(entry.cancel.subscribe())
    }

    fn authorize(&self, owner: &str, id: &str, binding: AiBinding) -> Result<(), String> {
        let mut entries = self.entries.lock().map_err(|_| "AI 请求状态不可用")?;
        let entry = entries.get_mut(id).ok_or("AI 请求已取消或失效")?;
        if entry.owner != owner || !matches!(entry.phase, AiRequestPhase::Authorizing) {
            return Err("AI 请求已取消或失效".into());
        }
        entry.phase = AiRequestPhase::Authorized(AiGrant {
            binding,
            issued: Instant::now(),
        });
        Ok(())
    }

    fn start(
        &self,
        owner: &str,
        id: &str,
        binding: &AiBinding,
    ) -> Result<watch::Receiver<bool>, String> {
        let mut entries = self.entries.lock().map_err(|_| "AI 请求状态不可用")?;
        let entry = entries.get_mut(id).ok_or("AI 请求已取消或失效")?;
        if entry.owner != owner {
            return Err("AI 请求窗口不匹配".into());
        }
        if !matches!(entry.phase, AiRequestPhase::Authorized(_)) {
            return Err("AI 请求缺少本次隐私授权".into());
        }
        let AiRequestPhase::Authorized(grant) =
            std::mem::replace(&mut entry.phase, AiRequestPhase::Running)
        else {
            unreachable!()
        };
        if &grant.binding != binding || grant.issued.elapsed() >= Duration::from_secs(60) {
            entries.remove(id);
            return Err("AI 内容、服务或隐私规则已变化，请重新确认".into());
        }
        Ok(entry.cancel.subscribe())
    }

    fn cancel(&self, owner: &str, id: &str) -> Result<(), String> {
        let mut entries = self.entries.lock().map_err(|_| "AI 请求状态不可用")?;
        if let Some(entry) = entries.get(id) {
            if entry.owner != owner {
                return Err("不能取消其他窗口的 AI 请求".into());
            }
            entry.cancel.send_replace(true);
            entries.remove(id);
        }
        Ok(())
    }

    fn finish(&self, id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(id);
        }
    }
}

fn ai_requests() -> &'static AiRequests {
    AI_REQUESTS.get_or_init(AiRequests::default)
}

/// 先登记再提交，保证取消早于 ai_chat 调度时也不会开始网络请求。
#[tauri::command]
pub fn begin_ai_request(window: WebviewWindow) -> Result<String, String> {
    ai_requests().prepare(window.label())
}

#[tauri::command]
pub fn cancel_ai_request(window: WebviewWindow, request_id: String) -> Result<(), String> {
    ai_requests().cancel(window.label(), &request_id)
}

async fn authorize_payload(
    requests: &AiRequests,
    owner: &str,
    id: &str,
    payload: &AiPayload,
    rules: &CustomSensitiveRules,
    confirm: impl FnOnce(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>,
) -> Result<(), String> {
    let cancel = requests.begin_authorization(owner, id)?;
    let result = run_cancellable(cancel, async {
        let binding = ai_binding(payload, rules)?;
        let summary = ai_sensitive_summary(payload, rules)?;
        if !summary.is_empty() {
            let message = format!(
                "用途：{}\nAI 服务：{}\n\n原文包含：{}。\n这些敏感内容将发送给上述 AI 服务。此前向其他应用保留原文的决定不适用于本次 AI 请求。\n\n是否仅允许本次发送？",
                payload.purpose.label(), binding.endpoint, summary.join("、")
            );
            if !confirm(message).await {
                return Err("已取消向 AI 发送敏感原文".into());
            }
        }
        requests.authorize(owner, id, binding)
    }).await;
    if result.is_err() {
        requests.finish(id);
    }
    result
}

#[tauri::command]
pub async fn authorize_ai_request(
    window: WebviewWindow,
    request_id: String,
    request: AiPayload,
) -> Result<(), String> {
    let rules = crate::privacy::load_custom_rules(window.app_handle())?;
    let owner = window.label().to_string();
    authorize_payload(
        ai_requests(),
        &owner,
        &request_id,
        &request,
        &rules,
        |message| {
            Box::pin(async move {
                let (send, receive) = tokio::sync::oneshot::channel();
                window
                    .dialog()
                    .message(message)
                    .title("确认 AI 敏感内容外发")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "仅本次发送原文".into(),
                        "取消".into(),
                    ))
                    .parent(&window)
                    .show(move |approved| {
                        let _ = send.send(approved);
                    });
                receive.await.unwrap_or(false)
            })
        },
    )
    .await
}

async fn run_cancellable<T>(
    mut cancel: watch::Receiver<bool>,
    operation: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    if *cancel.borrow() {
        return Err("AI 请求已取消".into());
    }
    tokio::select! {
        biased;
        _ = cancel.changed() => Err("AI 请求已取消".into()),
        result = operation => result,
    }
}

async fn run_authorized<T>(
    requests: &AiRequests,
    owner: &str,
    id: &str,
    payload: &AiPayload,
    rules: &CustomSensitiveRules,
    operation: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let binding = ai_binding(payload, rules)?;
    let cancel = requests.start(owner, id, &binding)?;
    let _cleanup = AiRequestCleanup { requests, id };
    run_cancellable(cancel, operation).await
}

struct AiRequestCleanup<'a> {
    requests: &'a AiRequests,
    id: &'a str,
}

impl Drop for AiRequestCleanup<'_> {
    fn drop(&mut self) {
        self.requests.finish(self.id);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiKeyStatus {
    configured: bool,
    updated_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAiKey {
    key: Option<String>,
    updated_at_ms: Option<u64>,
}

trait AiKeyStore {
    fn load(&self) -> Result<Option<StoredAiKey>, String>;
    fn save(&self, record: &StoredAiKey) -> Result<(), String>;
}

struct SystemAiKeyStore;

// 一次成功授权在本进程内复用；只缓存成功读取/写入，拒绝授权不缓存为空。
#[cfg(target_os = "macos")]
static KEY_CACHE: Mutex<Option<StoredAiKey>> = Mutex::new(None);

#[cfg(target_os = "macos")]
impl AiKeyStore for SystemAiKeyStore {
    fn load(&self) -> Result<Option<StoredAiKey>, String> {
        let mut cache = KEY_CACHE
            .lock()
            .map_err(|_| "AI 密钥缓存暂不可用".to_string())?;
        if let Some(record) = cache.as_ref() {
            return Ok(Some(record.clone()));
        }
        let record = crate::keychain_broker::load(crate::keychain_broker::Slot::Ai)
            .map_err(|error| error.to_string())?
            .map(|bytes| decode_keychain_record(&bytes))
            .transpose()?;
        *cache = record.clone();
        Ok(record)
    }

    fn save(&self, record: &StoredAiKey) -> Result<(), String> {
        let encoded = serde_json::to_vec(record).map_err(|_| "无法编码 AI 密钥记录".to_string())?;
        crate::keychain_broker::store(crate::keychain_broker::Slot::Ai, &encoded)
            .map_err(|error| error.to_string())?;
        *KEY_CACHE
            .lock()
            .map_err(|_| "AI 密钥缓存暂不可用".to_string())? = Some(record.clone());
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
impl AiKeyStore for SystemAiKeyStore {
    fn load(&self) -> Result<Option<StoredAiKey>, String> {
        Err("AI 密钥仅支持 macOS Keychain".into())
    }

    fn save(&self, _record: &StoredAiKey) -> Result<(), String> {
        Err("AI 密钥仅支持 macOS Keychain".into())
    }
}

fn decode_keychain_record(bytes: &[u8]) -> Result<StoredAiKey, String> {
    if let Ok(record) = serde_json::from_slice::<StoredAiKey>(bytes) {
        if let Some(key) = &record.key {
            normalize_key(key)?;
        }
        return Ok(record);
    }
    // 兼容未来之前可能写入的纯字符串条目；格式化 JSON 损坏不能被当成 key。
    if bytes.first() == Some(&b'{') {
        return Err("macOS 钥匙串中的 AI 密钥记录无效".into());
    }
    let plain =
        std::str::from_utf8(bytes).map_err(|_| "macOS 钥匙串中的 AI 密钥记录无效".to_string())?;
    Ok(StoredAiKey {
        key: Some(normalize_key(plain)?),
        updated_at_ms: None,
    })
}

fn normalize_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.is_empty() {
        return Err("API Key 不能为空".into());
    }
    if key.len() > MAX_KEY_BYTES || key.chars().any(char::is_control) {
        return Err("API Key 格式无效".into());
    }
    Ok(key.to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn status_with(store: &impl AiKeyStore) -> Result<AiKeyStatus, String> {
    Ok(match store.load()? {
        Some(record) => AiKeyStatus {
            configured: record.key.is_some(),
            updated_at_ms: record.key.and(record.updated_at_ms),
        },
        None => AiKeyStatus {
            configured: false,
            updated_at_ms: None,
        },
    })
}

fn set_key_with(
    store: &impl AiKeyStore,
    raw_key: &str,
    overwrite_existing: bool,
    updated_at_ms: u64,
) -> Result<AiKeyStatus, String> {
    let key = normalize_key(raw_key)?;
    if !overwrite_existing {
        if let Some(existing) = store.load()? {
            let Some(current) = existing.key else {
                return Err("AI 密钥此前已被用户删除；旧数据副本未自动恢复".into());
            };
            if current != key {
                return Err("macOS 钥匙串已配置不同的 AI 密钥；旧数据副本未被删除".into());
            }
            return Ok(AiKeyStatus {
                configured: true,
                updated_at_ms: existing.updated_at_ms,
            });
        }
    }
    let record = StoredAiKey {
        key: Some(key),
        updated_at_ms: Some(updated_at_ms),
    };
    store.save(&record)?;
    Ok(AiKeyStatus {
        configured: true,
        updated_at_ms: record.updated_at_ms,
    })
}

fn delete_key_with(store: &impl AiKeyStore, deleted_at_ms: u64) -> Result<AiKeyStatus, String> {
    // 用不含 secret 的 Keychain tombstone 原子覆盖原记录，防止应用在清理旧 JSON
    // 前退出后，下次启动又把用户明确删除的 legacy key 自动迁回。
    store.save(&StoredAiKey {
        key: None,
        updated_at_ms: Some(deleted_at_ms),
    })?;
    Ok(AiKeyStatus {
        configured: false,
        updated_at_ms: None,
    })
}

fn with_system_keychain<T>(
    operation: impl FnOnce(&SystemAiKeyStore) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = KEYCHAIN_LOCK
        .lock()
        .map_err(|_| "macOS 钥匙串访问暂不可用".to_string())?;
    operation(&SystemAiKeyStore)
}

fn emit_key_status(app: &AppHandle, status: &AiKeyStatus) {
    let _ = app.emit(AI_KEY_STATUS_EVENT, status);
}

/// 保存或覆盖 AI key。旧 JSON 迁移传 `overwrite_existing=false`，因此不会覆盖
/// 用户已在 Keychain 中设置的新 key；设置页显式保存传 true。
#[tauri::command]
pub async fn set_ai_api_key(
    app: AppHandle,
    api_key: String,
    overwrite_existing: bool,
) -> Result<AiKeyStatus, String> {
    let status = tauri::async_runtime::spawn_blocking(move || {
        with_system_keychain(|store| set_key_with(store, &api_key, overwrite_existing, now_ms()))
    })
    .await
    .map_err(|_| "AI 密钥保存任务失败".to_string())??;
    emit_key_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub async fn get_ai_key_status() -> Result<AiKeyStatus, String> {
    tauri::async_runtime::spawn_blocking(|| with_system_keychain(status_with))
        .await
        .map_err(|_| "AI 密钥状态查询任务失败".to_string())?
}

#[tauri::command]
pub async fn delete_ai_api_key(app: AppHandle) -> Result<AiKeyStatus, String> {
    let status = tauri::async_runtime::spawn_blocking(|| {
        with_system_keychain(|store| delete_key_with(store, now_ms()))
    })
    .await
    .map_err(|_| "AI 密钥删除任务失败".to_string())??;
    emit_key_status(&app, &status);
    Ok(status)
}

fn configured_key() -> Result<String, String> {
    with_system_keychain(|store| {
        store
            .load()?
            .and_then(|record| record.key)
            .ok_or_else(|| "AI API Key 尚未配置".to_string())
    })
}

fn is_loopback_host(host: Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address == std::net::Ipv4Addr::LOCALHOST,
        Host::Ipv6(address) => address == std::net::Ipv6Addr::LOCALHOST,
    }
}

pub(crate) fn validate_base_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Base URL 无效".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Base URL 不能包含用户名或密码".into());
    }
    let host = url
        .host()
        .ok_or_else(|| "Base URL 缺少有效 host".to_string())?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Base URL 不能包含 query 或 fragment".into());
    }
    match url.scheme() {
        "https" => Ok(url),
        "http" if is_loopback_host(host) => Ok(url),
        "http" => Err("远端 AI 服务只允许 HTTPS；HTTP 仅允许本机 loopback".into()),
        _ => Err("Base URL 只允许 HTTPS，或显式的本机 loopback HTTP".into()),
    }
}

pub(crate) fn build_ai_endpoint(base_url: &str, suffix: &str) -> Result<Url, String> {
    let base = validate_base_url(base_url)?;
    let normalized = format!("{}/", base.as_str().trim_end_matches('/'));
    Url::parse(&normalized)
        .map_err(|_| "Base URL 无效".to_string())?
        .join(suffix.trim_start_matches('/'))
        .map_err(|_| "无法构造 AI endpoint".to_string())
}

fn http_client() -> Result<&'static reqwest::Client, String> {
    if let Some(client) = HTTP_CLIENT.get() {
        return Ok(client);
    }
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(Policy::none())
        .user_agent("Toskr/AI")
        .build()
        .map_err(|_| "无法初始化安全 HTTP client".to_string())?;
    let _ = HTTP_CLIENT.set(client);
    HTTP_CLIENT
        .get()
        .ok_or_else(|| "无法初始化安全 HTTP client".to_string())
}

async fn bounded_success_body(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!("AI 服务返回错误（HTTP {}）", status.as_u16()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取 AI 响应失败".to_string())?
    {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("AI 响应超过安全上限".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn send_json(endpoint: Url, key: &str, body: serde_json::Value) -> Result<Vec<u8>, String> {
    let response = http_client()?
        .post(endpoint)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|_| "网络请求失败，请检查 Base URL 与网络连接".to_string())?;
    bounded_success_body(response).await
}

async fn send_get(endpoint: Url, key: &str) -> Result<Vec<u8>, String> {
    let response = http_client()?
        .get(endpoint)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|_| "网络请求失败，请检查 Base URL 与网络连接".to_string())?;
    bounded_success_body(response).await
}

/// 通用对话补全。前端只传 endpoint/model/content；key 在 Rust 内从 Keychain 读取。
#[tauri::command]
pub async fn ai_chat(
    window: WebviewWindow,
    request_id: String,
    request: AiPayload,
) -> Result<String, String> {
    let rules = crate::privacy::load_custom_rules(window.app_handle())?;
    let binding = ai_binding(&request, &rules)?;
    let app = window.app_handle().clone();
    run_authorized(
        ai_requests(),
        window.label(),
        &request_id,
        &request,
        &rules,
        async {
            let endpoint = build_ai_endpoint(&request.base_url, "v1/chat/completions")?;
            let key = tauri::async_runtime::spawn_blocking(configured_key)
                .await
                .map_err(|_| "AI 密钥读取任务失败".to_string())??;
            if ai_binding(&request, &crate::privacy::load_custom_rules(&app)?)? != binding {
                return Err("AI 隐私规则已变化，请重新确认".into());
            }
            let body = serde_json::json!({
                "model": request.model,
                "messages": [
                    {"role": "system", "content": request.system},
                    {"role": "user", "content": request.user},
                ],
                "max_tokens": request.max_tokens.clamp(50, 4000),
                "temperature": 0.3,
                "stream": false,
            });
            let response = send_json(endpoint, &key, body).await?;
            extract_content(&response)
        },
    )
    .await
}

/// 列出可用模型（GET /v1/models）。
#[tauri::command]
pub async fn ai_list_models(base_url: String) -> Result<Vec<String>, String> {
    let endpoint = build_ai_endpoint(&base_url, "v1/models")?;
    let key = tauri::async_runtime::spawn_blocking(configured_key)
        .await
        .map_err(|_| "AI 密钥读取任务失败".to_string())??;
    let response = send_get(endpoint, &key).await?;
    extract_model_ids(&response)
}

fn extract_model_ids(body: &[u8]) -> Result<Vec<String>, String> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| "模型列表响应非 JSON".to_string())?;
    if let Some(items) = value.get("data").and_then(serde_json::Value::as_array) {
        let mut ids: Vec<String> = items
            .iter()
            .filter_map(|item| item.get("id").and_then(serde_json::Value::as_str))
            .map(str::to_string)
            .collect();
        ids.sort();
        ids.dedup();
        if !ids.is_empty() {
            return Ok(ids);
        }
    }
    Err("模型列表响应格式异常".into())
}

fn extract_content(body: &[u8]) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| "AI 响应非 JSON".to_string())?;
    if let Some(content) = value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(serde_json::Value::as_str)
    {
        if content.trim().is_empty() {
            return Err("AI 返回内容为空（推理类模型请换用对话模型）".into());
        }
        return Ok(content.to_string());
    }
    Err("AI 响应格式异常".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_payload() -> AiPayload {
        AiPayload {
            base_url: "https://api.example.test".into(),
            model: "test".into(),
            system: "system".into(),
            user: "public content".into(),
            max_tokens: 300,
            purpose: AiPurpose::Summarize,
        }
    }

    fn test_binding() -> AiBinding {
        ai_binding(&test_payload(), &CustomSensitiveRules::default()).unwrap()
    }

    fn authorized_request(requests: &AiRequests, owner: &str) -> String {
        let id = requests.prepare(owner).unwrap();
        requests.begin_authorization(owner, &id).unwrap();
        requests.authorize(owner, &id, test_binding()).unwrap();
        id
    }

    #[tokio::test]
    async fn sensitive_payload_needs_independent_native_approval_before_any_transport() {
        let requests = AiRequests::default();
        let mut payload = test_payload();
        payload.user = "Authorization: Bearer abcdefghijklmnop".into();
        let rules = CustomSensitiveRules::default();
        let id = requests.prepare("main").unwrap();
        let sends = AtomicU64::new(0);
        let denied = run_authorized(&requests, "main", &id, &payload, &rules, async {
            sends.fetch_add(1, Ordering::Relaxed);
            Ok(())
        })
        .await;
        assert!(denied.is_err());
        let confirmation_count = AtomicU64::new(0);
        let approval = authorize_payload(&requests, "main", &id, &payload, &rules, |message| {
            confirmation_count.fetch_add(1, Ordering::Relaxed);
            assert!(message.contains("https://api.example.test/v1/chat/completions"));
            assert!(message.contains("总结要点"));
            assert!(message.contains("授权凭据"));
            assert!(!message.contains("abcdefghijklmnop"));
            Box::pin(async { false })
        })
        .await;
        assert!(approval.is_err());
        assert!(
            run_authorized(&requests, "main", &id, &payload, &rules, async {
                sends.fetch_add(1, Ordering::Relaxed);
                Ok(())
            })
            .await
            .is_err()
        );
        assert_eq!(confirmation_count.load(Ordering::Relaxed), 1);
        assert_eq!(sends.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn native_approval_is_single_use_and_all_binding_changes_reject_transport() {
        let requests = AiRequests::default();
        let rules = CustomSensitiveRules::default();
        let mut payload = test_payload();
        payload.user = "Authorization: Bearer abcdefghijklmnop".into();
        let sends = AtomicU64::new(0);
        for changed in 0..8 {
            let id = requests.prepare("main").unwrap();
            authorize_payload(&requests, "main", &id, &payload, &rules, |_| {
                Box::pin(async { true })
            })
            .await
            .unwrap();
            let mut altered = payload.clone();
            let mut changed_rules = rules.clone();
            let owner = if changed == 7 { "settings" } else { "main" };
            match changed {
                0 => altered.user.push('!'),
                1 => altered.system.push('!'),
                2 => altered.base_url = "https://another.example.test".into(),
                3 => altered.purpose = AiPurpose::SuggestTitle,
                4 => altered.model = "another-model".into(),
                5 => altered.max_tokens += 1,
                6 => {
                    changed_rules = CustomSensitiveRules::new(vec!["privateField".into()]).unwrap()
                }
                _ => {}
            }
            assert!(
                run_authorized(&requests, owner, &id, &altered, &changed_rules, async {
                    sends.fetch_add(1, Ordering::Relaxed);
                    Ok(())
                })
                .await
                .is_err(),
                "binding case {changed}"
            );
            requests.cancel("main", &id).unwrap();
        }
        assert_eq!(sends.load(Ordering::Relaxed), 0);
        let id = requests.prepare("main").unwrap();
        authorize_payload(&requests, "main", &id, &payload, &rules, |_| {
            Box::pin(async { true })
        })
        .await
        .unwrap();
        run_authorized(&requests, "main", &id, &payload, &rules, async {
            sends.fetch_add(1, Ordering::Relaxed);
            Ok(())
        })
        .await
        .unwrap();
        assert!(
            run_authorized(&requests, "main", &id, &payload, &rules, async {
                sends.fetch_add(1, Ordering::Relaxed);
                Ok(())
            })
            .await
            .is_err()
        );
        assert_eq!(sends.load(Ordering::Relaxed), 1);
        assert!(requests.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancellation_during_native_confirmation_cannot_issue_late_grant() {
        let requests = AiRequests::default();
        let id = requests.prepare("main").unwrap();
        let mut payload = test_payload();
        payload.system = "Authorization: Bearer abcdefghijklmnop".into();
        let rules = CustomSensitiveRules::default();
        let (approve, wait) = tokio::sync::oneshot::channel();
        let authorization = authorize_payload(&requests, "main", &id, &payload, &rules, |_| {
            requests.cancel("main", &id).unwrap();
            Box::pin(async move { wait.await.unwrap_or(false) })
        })
        .await;
        assert!(authorization.is_err());
        assert!(approve.send(true).is_err());
        assert!(requests
            .start("main", &id, &ai_binding(&payload, &rules).unwrap())
            .is_err());
        assert!(requests.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn custom_rules_and_both_message_roles_are_scanned_without_frontend_policy_flags() {
        let requests = AiRequests::default();
        let rules = CustomSensitiveRules::new(vec!["internalPin".into()]).unwrap();
        let mut payload = test_payload();
        payload.system = "internalPin=abc123".into();
        let id = requests.prepare("main").unwrap();
        let confirmations = AtomicU64::new(0);
        authorize_payload(&requests, "main", &id, &payload, &rules, |message| {
            confirmations.fetch_add(1, Ordering::Relaxed);
            assert!(message.contains("敏感字段"));
            assert!(!message.contains("abc123"));
            Box::pin(async { true })
        })
        .await
        .unwrap();
        assert_eq!(confirmations.load(Ordering::Relaxed), 1);
        if let AiRequestPhase::Authorized(grant) =
            &mut requests.entries.lock().unwrap().get_mut(&id).unwrap().phase
        {
            grant.issued = Instant::now() - Duration::from_secs(61);
        }
        let sent = AtomicU64::new(0);
        assert!(
            run_authorized(&requests, "main", &id, &payload, &rules, async {
                sent.fetch_add(1, Ordering::Relaxed);
                Ok(())
            })
            .await
            .is_err()
        );
        assert_eq!(sent.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn incomplete_scan_is_never_authorized_and_clean_content_needs_no_prompt() {
        let requests = AiRequests::default();
        let rules = CustomSensitiveRules::default();
        let mut payload = test_payload();
        payload.user = "x".repeat(crate::privacy::MAX_SCAN_INPUT_BYTES + 1);
        let id = requests.prepare("main").unwrap();
        assert!(
            authorize_payload(&requests, "main", &id, &payload, &rules, |_| {
                panic!("不完整扫描不得显示保留原文确认")
            })
            .await
            .is_err()
        );
        let clean = test_payload();
        let id = requests.prepare("main").unwrap();
        authorize_payload(&requests, "main", &id, &clean, &rules, |_| {
            panic!("干净内容不重复询问")
        })
        .await
        .unwrap();
        assert!(
            run_authorized(&requests, "main", &id, &clean, &rules, async { Ok(()) })
                .await
                .is_ok()
        );
    }

    #[test]
    fn cancellation_before_start_and_window_ownership_are_enforced() {
        let requests = AiRequests::default();
        let id = authorized_request(&requests, "main");
        assert!(requests.start("settings", &id, &test_binding()).is_err());
        assert!(requests.cancel("settings", &id).is_err());
        requests.cancel("main", &id).unwrap();
        assert!(requests.start("main", &id, &test_binding()).is_err());
        requests.cancel("main", &id).unwrap();
        assert!(requests.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancellation_wins_over_ready_result_and_duplicate_start_is_rejected() {
        let requests = AiRequests::default();
        let id = authorized_request(&requests, "main");
        let receiver = requests.start("main", &id, &test_binding()).unwrap();
        assert!(requests.start("main", &id, &test_binding()).is_err());
        requests.cancel("main", &id).unwrap();
        let result = run_cancellable(receiver, async { Ok("late result") }).await;
        assert_eq!(result.unwrap_err(), "AI 请求已取消");
    }

    #[test]
    fn abandoned_registrations_are_bounded_and_expire() {
        let requests = AiRequests::default();
        for _ in 0..64 {
            authorized_request(&requests, "main");
        }
        assert!(requests.prepare("main").is_err());
        for entry in requests.entries.lock().unwrap().values_mut() {
            entry.created = Instant::now() - Duration::from_secs(61);
        }
        let id = authorized_request(&requests, "main");
        assert_eq!(requests.entries.lock().unwrap().len(), 1);
        drop(AiRequestCleanup {
            requests: &requests,
            id: &id,
        });
        assert!(requests.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancellation_drops_live_http_response_and_closes_connection() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint =
            Url::parse(&format!("http://{}/chat", listener.local_addr().unwrap())).unwrap();
        let (ready, waiting) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&chunk[..count]);
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10000\r\n\r\n{")
                .await
                .unwrap();
            ready.send(()).unwrap();
            // 服务端不返回剩余响应；取消必须实际断开连接，不能只丢弃 UI 回执。
            match tokio::time::timeout(Duration::from_secs(2), socket.read(&mut chunk)).await {
                Ok(Ok(0)) | Ok(Err(_)) => {}
                other => panic!("取消未关闭 HTTP 连接: {other:?}"),
            }
        });
        let requests = AiRequests::default();
        let id = authorized_request(&requests, "main");
        let receiver = requests.start("main", &id, &test_binding()).unwrap();
        let transport = tokio::spawn(async move {
            run_cancellable(
                receiver,
                send_json(
                    endpoint,
                    "local-test-key",
                    serde_json::json!({"test": true}),
                ),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), waiting)
            .await
            .unwrap()
            .unwrap();
        requests.cancel("main", &id).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), transport)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err(), "AI 请求已取消");
        server.await.unwrap();
        assert!(requests.entries.lock().unwrap().is_empty());
    }

    #[derive(Default)]
    struct MemoryKeyStore {
        record: Mutex<Option<StoredAiKey>>,
        fail_save: bool,
    }

    impl AiKeyStore for MemoryKeyStore {
        fn load(&self) -> Result<Option<StoredAiKey>, String> {
            Ok(self.record.lock().unwrap().clone())
        }

        fn save(&self, record: &StoredAiKey) -> Result<(), String> {
            if self.fail_save {
                return Err("test keychain unavailable".into());
            }
            *self.record.lock().unwrap() = Some(record.clone());
            Ok(())
        }
    }

    #[test]
    fn url_policy_accepts_https_and_explicit_loopback_http_only() {
        for valid in [
            "https://api.example.com",
            "https://api.example.com/openai/compatible",
            "http://localhost:11434",
            "http://127.0.0.1:8000",
            "http://[::1]:8080",
        ] {
            assert!(validate_base_url(valid).is_ok(), "应允许 {valid}");
        }
        for invalid in [
            "http://api.example.com",
            "http://localhost.example.com",
            "http://127.0.0.2:8000",
            "https://user:pass@example.com",
            "ftp://example.com",
            "file:///tmp/model",
            "not a url",
            "https://",
        ] {
            assert!(validate_base_url(invalid).is_err(), "应拒绝 {invalid}");
        }
    }

    #[test]
    fn endpoint_uses_validated_base_without_losing_path_prefix() {
        assert_eq!(
            build_ai_endpoint(
                "https://dashscope.aliyuncs.com/compatible-mode/",
                "v1/chat/completions"
            )
            .unwrap()
            .as_str(),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        );
    }

    #[test]
    fn key_store_can_be_replaced_and_migration_never_discards_a_different_key() {
        let store = MemoryKeyStore::default();
        let first = set_key_with(&store, "sk-current", true, 10).unwrap();
        assert_eq!(first.updated_at_ms, Some(10));
        let same = set_key_with(&store, "sk-current", false, 20).unwrap();
        assert_eq!(same.updated_at_ms, Some(10));
        let conflict = set_key_with(&store, "sk-legacy", false, 30).unwrap_err();
        assert!(!conflict.contains("sk-current"));
        assert!(!conflict.contains("sk-legacy"));
        assert_eq!(
            store.load().unwrap().unwrap().key.as_deref(),
            Some("sk-current")
        );
        delete_key_with(&store, 40).unwrap();
        assert!(!status_with(&store).unwrap().configured);
        let deleted_migration = set_key_with(&store, "sk-current", false, 50).unwrap_err();
        assert!(!deleted_migration.contains("sk-current"));
        assert!(!status_with(&store).unwrap().configured);
    }

    #[test]
    fn failed_keychain_write_does_not_claim_configuration() {
        let store = MemoryKeyStore {
            record: Mutex::new(None),
            fail_save: true,
        };
        assert!(set_key_with(&store, "sk-recover", true, 30).is_err());
        assert!(store.load().unwrap().is_none());
    }

    #[test]
    fn extracts_content_and_model_ids_without_echoing_provider_errors() {
        let body = r#"{"choices":[{"message":{"content":"{\"title\":\"开会\"}"}}]}"#;
        assert_eq!(
            extract_content(body.as_bytes()).unwrap(),
            "{\"title\":\"开会\"}"
        );
        let models = br#"{"data":[{"id":"b-model"},{"id":"a-model"},{"id":"a-model"}]}"#;
        assert_eq!(
            extract_model_ids(models).unwrap(),
            vec!["a-model".to_string(), "b-model".to_string()]
        );
        let secret = "sk-provider-echoed-secret";
        let error_body = format!(r#"{{"error":{{"message":"bad key {secret}"}}}}"#);
        let error = extract_content(error_body.as_bytes()).unwrap_err();
        assert!(!error.contains(secret));
        assert!(!error.contains("bad key"));
    }

    #[test]
    fn transport_has_no_child_process_argument_surface() {
        let source = include_str!("ai.rs");
        let process_builder = ["Command", "::new"].concat();
        let process_module = ["std", "::process"].concat();
        assert!(!source.contains(&process_builder));
        assert!(!source.contains(&process_module));
        assert!(http_client().is_ok());
    }
}
