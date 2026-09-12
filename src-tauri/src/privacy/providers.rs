use super::*;

// 格式参考 privacy-filter 的固定规则快照：
// https://github.com/packyme/privacy-filter/blob/64b8de3c206059b187d65381189b70c267550392/rules/gitleaks.toml
// 只采用供应商格式；不继承熵阈值或 URL / Hash 豁免。
static ALIBABA_RE: OnceLock<Regex> = OnceLock::new();
static CLOUDFLARE_TOKEN_RE: OnceLock<Regex> = OnceLock::new();
static CLOUDFLARE_GLOBAL_RE: OnceLock<Regex> = OnceLock::new();
static CLOUDFLARE_ORIGIN_RE: OnceLock<Regex> = OnceLock::new();
static HUGGINGFACE_RE: OnceLock<Regex> = OnceLock::new();
static DIGITALOCEAN_RE: OnceLock<Regex> = OnceLock::new();
static SENDGRID_RE: OnceLock<Regex> = OnceLock::new();

pub(super) fn collect(text: &str, candidates: &mut Vec<Candidate>) {
    let lower = text.to_ascii_lowercase();
    for (cell, pattern, rule_id, dot_is_token) in [
        (
            &ALIBABA_RE,
            r"(?P<secret>LTAI[A-Za-z0-9]{20})",
            "token.alibaba_access_key_id",
            false,
        ),
        (
            &CLOUDFLARE_TOKEN_RE,
            r#"(?i)(?:^|[^\p{L}\p{N}_.-])(?:cloudflare|cf)[_ -]*(?:api[_ -]*token|api[_ -]*key|token)["']?[ \t]*[:=][ \t]*["']?(?P<secret>[a-z0-9_-]{40})"#,
            "token.cloudflare_api_token",
            false,
        ),
        (
            &CLOUDFLARE_GLOBAL_RE,
            r#"(?i)(?:^|[^\p{L}\p{N}_.-])(?:cloudflare|cf)[_ -]*(?:global[_ -]*(?:api[_ -]*)?key|api[_ -]*key)["']?[ \t]*[:=][ \t]*["']?(?P<secret>[a-f0-9]{37})"#,
            "token.cloudflare_global_api_key",
            false,
        ),
        (
            &CLOUDFLARE_ORIGIN_RE,
            r"(?P<secret>v1\.0-[a-f0-9]{24}-[a-f0-9]{146})",
            "token.cloudflare_origin_ca_key",
            false,
        ),
        (
            &HUGGINGFACE_RE,
            r"(?P<secret>(?:hf_|api_org_)[A-Za-z]{34})",
            "token.huggingface",
            false,
        ),
        (
            &DIGITALOCEAN_RE,
            r"(?P<secret>do[opr]_v1_[a-f0-9]{64})",
            "token.digitalocean",
            false,
        ),
        (
            &SENDGRID_RE,
            r"(?P<secret>SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})",
            "token.sendgrid",
            true,
        ),
    ] {
        let keywords: &[&str] = match rule_id {
            "token.alibaba_access_key_id" => &["ltai"],
            "token.cloudflare_api_token" | "token.cloudflare_global_api_key" => {
                &["cloudflare", "cf"]
            }
            "token.cloudflare_origin_ca_key" => &["v1.0-"],
            "token.huggingface" => &["hf_", "api_org_"],
            "token.digitalocean" => &["dop_v1_", "doo_v1_", "dor_v1_"],
            "token.sendgrid" => &["sg."],
            _ => unreachable!("供应商规则必须声明预筛关键词"),
        };
        if !keywords.iter().any(|keyword| lower.contains(keyword)) {
            continue;
        }
        add_capture_candidates(
            text,
            built_in_regex(cell, pattern),
            RuleSpec {
                capture_name: Some("secret"),
                category: FindingCategory::ApiKey,
                severity: FindingSeverity::Block,
                rule_id,
            },
            |_, start, end, _| {
                token_boundary(text, start, end, dot_is_token)
                    && !text[..start].ends_with('-')
                    && !text[end..].starts_with(['-', '='])
            },
            candidates,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn examples() -> Vec<(&'static str, String, &'static str)> {
        vec![
            (
                "",
                format!("LTAI{}", "aB12".repeat(5)),
                "token.alibaba_access_key_id",
            ),
            (
                "CLOUDFLARE_API_TOKEN=",
                "ab-CD_12".repeat(5),
                "token.cloudflare_api_token",
            ),
            (
                "CF_API_KEY=",
                "a".repeat(37),
                "token.cloudflare_global_api_key",
            ),
            (
                "",
                format!("v1.0-{}-{}", "a".repeat(24), "b".repeat(146)),
                "token.cloudflare_origin_ca_key",
            ),
            ("", format!("hf_{}", "aB".repeat(17)), "token.huggingface"),
            (
                "",
                format!("api_org_{}", "cD".repeat(17)),
                "token.huggingface",
            ),
            (
                "",
                format!("dop_v1_{}", "a1".repeat(32)),
                "token.digitalocean",
            ),
            (
                "",
                format!("doo_v1_{}", "b2".repeat(32)),
                "token.digitalocean",
            ),
            (
                "",
                format!("dor_v1_{}", "c3".repeat(32)),
                "token.digitalocean",
            ),
            (
                "",
                format!("SG.{}.{}", "a".repeat(22), "B".repeat(43)),
                "token.sendgrid",
            ),
        ]
    }

    #[test]
    fn provider_secrets_have_exact_replacement_ranges() {
        for (label, secret, rule_id) in examples() {
            let text = format!("示例😀 {label}\"{secret}\"; 保留");
            let mut matches = Vec::new();
            collect(&text, &mut matches);
            assert_eq!(matches.len(), 1, "{rule_id}");
            let hit = &matches[0];
            assert_eq!(hit.rule_id, rule_id);
            assert_eq!(&text[hit.start_byte..hit.end_byte], secret);
            let replaced = format!(
                "{}[API_KEY_01]{}",
                &text[..hit.start_byte],
                &text[hit.end_byte..]
            );
            assert_eq!(replaced, format!("示例😀 {label}\"[API_KEY_01]\"; 保留"));
            matches.clear();
            collect(&replaced, &mut matches);
            assert!(matches.is_empty(), "{rule_id}");
        }
    }

    #[test]
    fn provider_formats_reject_truncated_and_extended_values() {
        for (label, secret, rule_id) in examples() {
            for value in [
                secret[..secret.len() - 1].to_string(),
                format!("{secret}x"),
                format!("{secret}_"),
                format!("{secret}-extra"),
                format!("x{secret}"),
            ] {
                let mut matches = Vec::new();
                collect(&format!("{label}\"{value}\""), &mut matches);
                assert!(matches.is_empty(), "{rule_id}");
            }
        }
    }

    #[test]
    fn cloudflare_requires_exact_provider_field_context() {
        for text in [
            "a".repeat(40),
            "a".repeat(37),
            format!("cloudflare_cache_hash={}", "a".repeat(40)),
            format!("other_cloudflare_api_token={}", "a".repeat(40)),
            format!("cloudflare_api_token_extra={}", "a".repeat(40)),
            format!("cloudflare_api_token\n{}", "a".repeat(40)),
        ] {
            let mut matches = Vec::new();
            collect(&text, &mut matches);
            assert!(matches.is_empty());
        }
    }

    #[test]
    fn provider_secrets_inside_urls_are_not_exempted() {
        let secret = format!("hf_{}", "a".repeat(34));
        let text = format!("https://example.com/?token={secret}&page=1");
        let mut matches = Vec::new();
        collect(&text, &mut matches);
        assert_eq!(matches.len(), 1);
        assert_eq!(&text[matches[0].start_byte..matches[0].end_byte], secret);
    }
}
