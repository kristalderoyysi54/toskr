//! OpenAI 兼容 AI 传输边界。
//!
//! API key 只存在 macOS Keychain 与当前 Rust 请求内存，不进入 WebView 状态、
//! 进程参数或诊断日志。HTTP 使用进程内 reqwest；远端只允许 HTTPS，HTTP 仅允许
//! 精确 loopback。响应错误只返回状态级信息，不回显 provider body。

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use url::{Host, Url};

#[cfg(target_os = "macos")]
use security_framework::passwords::{get_generic_password, set_generic_password};
#[cfg(target_os = "macos")]
use security_framework_sys::base::errSecItemNotFound;

const KEYCHAIN_SERVICE: &str = "com.toskr.app.ai";
const KEYCHAIN_ACCOUNT: &str = "openai-compatible";
const AI_KEY_STATUS_EVENT: &str = "toskr://ai-key-status";
const MAX_KEY_BYTES: usize = 8 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

static KEYCHAIN_LOCK: Mutex<()> = Mutex::new(());
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

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

#[cfg(target_os = "macos")]
impl AiKeyStore for SystemAiKeyStore {
    fn load(&self) -> Result<Option<StoredAiKey>, String> {
        match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            Ok(bytes) => decode_keychain_record(&bytes).map(Some),
            Err(error) if error.code() == errSecItemNotFound => Ok(None),
            Err(_) => Err("无法访问 macOS 钥匙串".into()),
        }
    }

    fn save(&self, record: &StoredAiKey) -> Result<(), String> {
        let encoded = serde_json::to_vec(record).map_err(|_| "无法编码 AI 密钥记录".to_string())?;
        set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, &encoded)
            .map_err(|_| "无法写入 macOS 钥匙串".to_string())
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
    base_url: String,
    model: String,
    system: String,
    user: String,
    max_tokens: u32,
) -> Result<String, String> {
    let endpoint = build_ai_endpoint(&base_url, "v1/chat/completions")?;
    let key = tauri::async_runtime::spawn_blocking(configured_key)
        .await
        .map_err(|_| "AI 密钥读取任务失败".to_string())??;
    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens.clamp(50, 4000),
        "temperature": 0.3,
        "stream": false,
    });
    let response = send_json(endpoint, &key, body).await?;
    extract_content(&response)
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
