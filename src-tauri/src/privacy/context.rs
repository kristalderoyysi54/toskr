use super::*;

pub(super) fn unquote(value: &str) -> &str {
    if value.len() >= 2
        && matches!(value.as_bytes()[0], b'\'' | b'"')
        && value.as_bytes().last() == value.as_bytes().first()
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

// 弱号码识别只豁免紧邻的业务编号标签，不影响显式手机号/银行卡规则。
fn business_number_context(text: &str, start: usize) -> bool {
    static LABEL: OnceLock<Regex> = OnceLock::new();
    let from = text[..start]
        .char_indices()
        .rev()
        .nth(96)
        .map_or(0, |(i, _)| i);
    built_in_regex(&LABEL, r#"(?i)(?:订单(?:号|编号)?|流水号|交易号|编号|\b(?:order(?:[_ -]?(?:id|number|no))?|reference|invoice|transaction[_ -]?id|id))["']?[ \t]*[:：=#]?[ \t]*["']?$"#)
        .is_match(&text[from..start])
}

pub(super) fn email_is_remote_target(text: &str, start: usize, end: usize) -> bool {
    static COMMAND: OnceLock<Regex> = OnceLock::new();
    static COPY_COMMAND: OnceLock<Regex> = OnceLock::new();
    // 只排除明确的 SSH URL、git 用户的 scp URL 和紧邻命令的目标参数。
    // 不能因为同一行讨论过 ssh 就豁免后面的真实邮箱。
    let prefix = &text[..start];
    let suffix = &text[end..];
    if prefix.ends_with("ssh://") || prefix.ends_with("git+ssh://") {
        return true;
    }
    if text[start..end].starts_with("git@")
        && suffix.starts_with(':')
        && suffix[1..]
            .chars()
            .next()
            .is_some_and(|ch| !ch.is_whitespace())
    {
        return true;
    }
    let from = prefix.char_indices().rev().nth(128).map_or(0, |(i, _)| i);
    built_in_regex(
        &COMMAND,
        r"(?:^|[\s;|&])(?:ssh|scp|sftp|rsync|ssh-copy-id)[ \t]+(?:(?:-[pPilJoF][ \t]+[^\s;|&]+|-[A-Za-z]+)[ \t]+)*$",
    )
    .is_match(&prefix[from..])
        || ((suffix.starts_with(":/") || suffix.starts_with(":~/") || suffix.starts_with(":./"))
            && built_in_regex(&COPY_COMMAND, r"(?:^|[;|&])[ \t]*(?:scp|rsync)[ \t]+[^\r\n;|&]*$")
                .is_match(&prefix[from..]))
}

pub(super) fn collect(text: &str, candidates: &mut Vec<Candidate>) {
    static PASSWORD: OnceLock<Regex> = OnceLock::new();
    static TEMPLATE: OnceLock<Regex> = OnceLock::new();
    static PHONE: OnceLock<Regex> = OnceLock::new();
    static CARD: OnceLock<Regex> = OnceLock::new();
    let lower = text.to_ascii_lowercase();
    if ["password", "passwd", "pwd", "密码", "口令"]
        .iter()
        .any(|word| lower.contains(word))
    {
        add_capture_candidates(
            text,
            built_in_regex(
                &PASSWORD,
                r#"(?i)(?:\b(?:[a-z0-9]+_)*(?:password|passwd|pwd)\b|密码|口令)["']?[ \t]*(?:是|为|[:：=])[ \t]*(?P<secret>"[^"\r\n]+"|'[^'\r\n]+'|[^\s"'，。；]+)"#,
            ),
            RuleSpec {
                capture_name: Some("secret"),
                category: FindingCategory::ApiKey,
                severity: FindingSeverity::Block,
                rule_id: "credential.context_password",
            },
            |value, _, _, _| {
                let lower = value.to_ascii_lowercase();
                !value.is_empty()
                    && !built_in_regex(&TEMPLATE, r"^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{\{[ \t]*[A-Za-z_][A-Za-z0-9_.]*[ \t]*\}\}|%[A-Za-z_][A-Za-z0-9_]*%|<[A-Za-z_][A-Za-z0-9_]*>)$").is_match(value)
                    && !matches!(
                        lower.as_str(),
                        "null"
                            | "none"
                            | "true"
                            | "false"
                            | "required"
                            | "optional"
                            | "changeme"
                            | "change_me"
                            | "placeholder"
                            | "your_password"
                            | "redacted"
                            | "未设置"
                            | "不需要"
                            | "字符串"
                            | "空的"
                            | "空"
                            | "无"
                            | "一个字符串"
                            | "必填字段"
                    )
            },
            candidates,
        );
    }
    add_capture_candidates(
        text,
        built_in_regex(
            &PHONE,
            r"(?P<secret>(?:\+?86[ -]?)?1[3-9][0-9](?:[ -]?[0-9]{4}){2})",
        ),
        RuleSpec {
            capture_name: Some("secret"),
            category: FindingCategory::Phone,
            severity: FindingSeverity::Warn,
            rule_id: "contact.phone_cn_unlabeled",
        },
        |value, start, end, captures| {
            token_boundary(text, start, end, true)
                && !business_number_context(text, start)
                && valid_phone(value, start, end, captures)
        },
        candidates,
    );
    add_capture_candidates(
        text,
        built_in_regex(&CARD, r"(?P<secret>[0-9]{13,19})"),
        RuleSpec {
            capture_name: Some("secret"),
            category: FindingCategory::BankCard,
            severity: FindingSeverity::Warn,
            rule_id: "financial.bank_card_unlabeled",
        },
        |value, start, end, captures| {
            token_boundary(text, start, end, true)
                && !business_number_context(text, start)
                && !valid_mainland_id(value)
                && luhn_valid(value, start, end, captures)
        },
        candidates,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    fn findings(text: &str) -> Vec<FirewallFinding> {
        scan_sensitive_text(ScanSensitiveRequest { text: text.into() }).findings
    }
    #[test]
    fn password_values_are_exact_and_replacements_rescan_clean() {
        for (prefix, value, suffix) in [
            ("我的密码是 ", "Ab9!xY2@", "。"),
            ("口令为", "123456", "；"),
            ("password: ", "123456", ""),
            ("password: ", "123", ""),
            ("password=", "ab;cdEF", ""),
            ("password=", "ab,cdEF", ""),
            ("password=", "%secret123", ""),
            ("password=", "${PREFIX}realSecret", ""),
            ("password: \"", "abc'def'", "\""),
            ("DB_PASSWORD=", "1234", ""),
            ("🙂密码：\"", "a b.)]}", "\""),
            ("password='", "a b c!", "'"),
        ] {
            let text = format!("{prefix}{value}{suffix}");
            let found = findings(&text);
            assert_eq!(found.len(), 1, "{text}: {found:?}");
            let f = &found[0];
            let units: Vec<_> = text.encode_utf16().collect();
            assert_eq!(
                String::from_utf16(&units[f.start_utf16..f.end_utf16]).unwrap(),
                value
            );
            assert_eq!(f.severity, FindingSeverity::Block);
            let replaced = format!("{prefix}[API_KEY_01]{suffix}");
            assert!(findings(&replaced).is_empty(), "{replaced}");
        }
        for text in [
            "密码不是123456",
            "password=${PASSWORD}",
            "password: null",
            "password: required",
            "password: <YOUR_PASSWORD>",
            "password: changeme",
            "password_min_length=12345678",
            "password: [API_KEY_01]",
            "密码为未设置",
            "密码是一个字符串",
            "密码为必填字段",
        ] {
            assert!(findings(text).is_empty(), "{text}");
        }
    }
    #[test]
    fn remote_targets_do_not_exempt_other_emails_on_the_line() {
        for text in [
            "ssh deploy@example.com",
            "ssh -p 22 deploy@example.com",
            "scp ./file deploy@example.com:/tmp",
            "git@example.com:team/repo.git",
            "ssh://deploy@example.com/repo",
            "scp deploy@example.com:/tmp/file .",
        ] {
            assert!(findings(text).is_empty(), "{text}");
        }
        for text in [
            "alice@example.com:密码",
            "讨论 ssh 的支持邮箱 alice@example.com",
            "ssh deploy@example.com 联系邮箱 help@example.org",
        ] {
            assert_eq!(
                findings(text)
                    .iter()
                    .filter(|f| f.category == FindingCategory::Email)
                    .count(),
                1,
                "{text}"
            );
        }
    }
    #[test]
    fn unlabeled_numbers_preserve_business_identifiers_and_boundaries() {
        for text in ["联系我 13800138000", "138 0013 8000", "+86 13800138000"] {
            assert!(
                findings(text)
                    .iter()
                    .any(|f| f.category == FindingCategory::Phone),
                "{text}"
            );
        }
        assert!(findings("4111111111111111")
            .iter()
            .any(|f| f.category == FindingCategory::BankCard));
        for text in [
            "订单号 13800138000",
            "编号：13800138000",
            "order_id=13800138000",
            "reference 4111111111111111",
            "invoice: 4111111111111111",
            "a13800138000b",
            "9138001380001",
            "4111111111111112",
            "0000000000000000",
        ] {
            assert!(findings(text).is_empty(), "{text}: {:?}", findings(text));
        }
        assert!(findings("订单号 123；手机：13800138000")
            .iter()
            .any(|f| f.category == FindingCategory::Phone));
    }
}
