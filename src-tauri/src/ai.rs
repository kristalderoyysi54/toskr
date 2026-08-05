//! OpenAI 兼容 AI 调用：系统 curl 子进程 POST /v1/chat/completions。
//!
//! 与 linkmeta.rs 同款 curl 模式（无 HTTP crate 依赖）。请求体走 stdin
//! （避免长 body 进 argv）；刻意不写任何诊断日志——密钥/内容绝不落
//! toskr-diag.log。已知残留风险：Authorization 头仍在 curl argv 中，
//! 本机 `ps` 在子进程存活期（<1s）可见，后续可改 `-K` 配置文件加固。

use std::io::Write;
use std::process::{Command, Stdio};

/// 通用对话补全：前端传提供商配置与 system/user 两条消息，返回 content 文本。
#[tauri::command]
pub async fn ai_chat(
    base_url: String,
    api_key: String,
    model: String,
    system: String,
    user: String,
    max_tokens: u32,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        chat_blocking(
            &base_url,
            &api_key,
            &model,
            &system,
            &user,
            max_tokens.clamp(50, 4000),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// base_url 去尾斜杠后拼固定后缀（兼容 dashscope 的 /compatible-mode 这类带路径前缀的 base）。
fn build_endpoint(base_url: &str) -> String {
    format!("{}/v1/chat/completions", base_url.trim().trim_end_matches('/'))
}

fn chat_blocking(
    base_url: &str,
    api_key: &str,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let url = build_endpoint(base_url);
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Base URL 需以 http(s):// 开头".into());
    }
    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.3,
        "stream": false,
    });
    let payload = serde_json::to_vec(&body).map_err(|e| e.to_string())?;

    let mut child = Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            "30",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "-H",
            &format!("Authorization: Bearer {api_key}"),
            "-w",
            "\u{1}%{http_code}",
            "--data",
            "@-",
            "--",
            &url,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl 启动失败: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("curl stdin 不可用")?
        .write_all(&payload)
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("网络请求失败，请检查 Base URL 与网络连接".into());
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let (body_str, http_code) = raw.rsplit_once('\u{1}').unwrap_or((raw.as_ref(), "0"));
    extract_content(body_str, http_code)
}

/// 列出可用模型（GET /v1/models）。返回按字典序排序的模型 id 列表。
#[tauri::command]
pub async fn ai_list_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || list_models_blocking(&base_url, &api_key))
        .await
        .map_err(|e| e.to_string())?
}

fn list_models_blocking(base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
    let url = format!(
        "{}/v1/models",
        base_url.trim().trim_end_matches('/')
    );
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Base URL 需以 http(s):// 开头".into());
    }
    let out = std::process::Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            "15",
            "-H",
            &format!("Authorization: Bearer {api_key}"),
            "-w",
            "\u{1}%{http_code}",
            "--",
            &url,
        ])
        .output()
        .map_err(|e| format!("curl 启动失败: {e}"))?;
    if !out.status.success() {
        return Err("网络请求失败，请检查 Base URL 与网络连接".into());
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let (body, http_code) = raw.rsplit_once('\u{1}').unwrap_or((raw.as_ref(), "0"));
    extract_model_ids(body, http_code)
}

/// data[].id 列表；缺失时退 OpenAI 风格 error.message / HTTP 码。
fn extract_model_ids(body: &str, http_code: &str) -> Result<Vec<String>, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| format!("模型列表响应非 JSON（HTTP {http_code}）"))?;
    if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
        let mut ids: Vec<String> = arr
            .iter()
            .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(str::to_string))
            .collect();
        ids.sort();
        ids.dedup();
        if !ids.is_empty() {
            return Ok(ids);
        }
    }
    if let Some(msg) = v
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
    {
        return Err(format!("AI 服务错误：{msg}"));
    }
    Err(format!("模型列表响应异常（HTTP {http_code}）"))
}

/// choices[0].message.content 优先；否则取 OpenAI 风格 error.message；都没有则报 HTTP 码。
fn extract_content(body: &str, http_code: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| format!("AI 响应非 JSON（HTTP {http_code}）"))?;
    if let Some(c) = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c0| c0.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
    {
        if c.trim().is_empty() {
            return Err("AI 返回内容为空（推理类模型请换用对话模型）".into());
        }
        return Ok(c.to_string());
    }
    if let Some(msg) = v
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
    {
        return Err(format!("AI 服务错误：{msg}"));
    }
    Err(format!("AI 响应格式异常（HTTP {http_code}）"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_joins_with_and_without_trailing_slash() {
        assert_eq!(
            build_endpoint("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            build_endpoint("https://api.deepseek.com/"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn endpoint_keeps_path_prefix() {
        assert_eq!(
            build_endpoint("https://dashscope.aliyuncs.com/compatible-mode/"),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        );
    }

    #[test]
    fn extract_ok_content() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"{\"title\":\"开会\"}"}}]}"#;
        assert_eq!(extract_content(body, "200").unwrap(), "{\"title\":\"开会\"}");
    }

    #[test]
    fn extract_openai_error_message() {
        let body = r#"{"error":{"message":"Invalid API key","type":"auth"}}"#;
        let err = extract_content(body, "401").unwrap_err();
        assert!(err.contains("Invalid API key"));
    }

    #[test]
    fn extract_model_ids_sorts_and_dedups() {
        let body = r#"{"data":[{"id":"b-model"},{"id":"a-model"},{"id":"a-model"}]}"#;
        assert_eq!(
            extract_model_ids(body, "200").unwrap(),
            vec!["a-model".to_string(), "b-model".to_string()]
        );
        assert!(extract_model_ids(r#"{"data":[]}"#, "200").is_err());
    }

    #[test]
    fn extract_rejects_non_json_and_empty_choices() {
        assert!(extract_content("<html>oops</html>", "502")
            .unwrap_err()
            .contains("502"));
        assert!(extract_content(r#"{"choices":[]}"#, "200")
            .unwrap_err()
            .contains("格式异常"));
    }
}
