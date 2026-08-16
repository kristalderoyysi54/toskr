//! 每日汇率抓取：open.er-api.com 免费端点（USD 基准，无需 API key）。
//! 前端按日缓存（localStorage），本命令只负责取数与解析；失败即 Err，
//! 前端回退到过期缓存或分币种分列显示。

use std::collections::HashMap;

#[tauri::command]
pub async fn fetch_exchange_rates() -> Result<HashMap<String, f64>, String> {
    tauri::async_runtime::spawn_blocking(fetch_blocking)
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_blocking() -> Result<HashMap<String, f64>, String> {
    let out = std::process::Command::new("curl")
        .args([
            "-sL",
            "--max-time",
            "8",
            "--max-filesize",
            "1048576",
            "--",
            "https://open.er-api.com/v6/latest/USD",
        ])
        .output()
        .map_err(|e| format!("curl 启动失败: {e}"))?;
    parse_rates(&String::from_utf8_lossy(&out.stdout))
}

fn parse_rates(body: &str) -> Result<HashMap<String, f64>, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("汇率响应解析失败: {e}"))?;
    if value.get("result").and_then(|v| v.as_str()) != Some("success") {
        return Err("汇率服务返回失败".into());
    }
    let rates = value
        .get("rates")
        .and_then(|v| v.as_object())
        .ok_or("汇率响应缺少 rates")?;
    let map: HashMap<String, f64> = rates
        .iter()
        .filter_map(|(code, rate)| rate.as_f64().map(|r| (code.clone(), r)))
        .filter(|(_, rate)| rate.is_finite() && *rate > 0.0)
        .collect();
    if map.is_empty() {
        return Err("汇率数据为空".into());
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_success_payload_and_drops_bad_rates() {
        let body = r#"{"result":"success","rates":{"USD":1,"CNY":7.18,"EUR":0.92,"BAD":0,"NEG":-1}}"#;
        let rates = parse_rates(body).unwrap();
        assert_eq!(rates.len(), 3);
        assert!((rates["CNY"] - 7.18).abs() < 1e-9);
    }

    #[test]
    fn rejects_error_payload_and_garbage() {
        assert!(parse_rates(r#"{"result":"error"}"#).is_err());
        assert!(parse_rates("not json").is_err());
        assert!(parse_rates(r#"{"result":"success","rates":{}}"#).is_err());
    }
}
