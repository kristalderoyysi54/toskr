use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine;
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};

pub const MAX_SCAN_INPUT_BYTES: usize = 2 * 1024 * 1024;
/// OCR 缓存与规则结果的显式失效版本。任何检测规则语义变化都必须递增。
pub const FIREWALL_RULE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FindingCategory {
    PrivateKey,
    Authorization,
    ApiKey,
    DatabaseUrl,
    Email,
    Phone,
    NationalId,
    BankCard,
    IpAddress,
    Cookie,
    Session,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FindingSeverity {
    Info,
    Warn,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallFinding {
    pub id: String,
    pub category: FindingCategory,
    pub severity: FindingSeverity,
    pub start_utf16: usize,
    pub end_utf16: usize,
    pub masked_preview: String,
    pub suggested_placeholder: String,
    pub rule_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSensitiveRequest {
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanWarningCode {
    InputTooLong,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanWarning {
    pub code: ScanWarningCode,
    pub message: String,
    pub max_bytes: usize,
    pub actual_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSensitiveResult {
    pub findings: Vec<FirewallFinding>,
    pub warnings: Vec<ScanWarning>,
    pub input_utf16: usize,
    pub scanned_utf16: usize,
    pub complete: bool,
}

#[derive(Debug, Clone)]
struct Candidate {
    category: FindingCategory,
    severity: FindingSeverity,
    start_byte: usize,
    end_byte: usize,
    range_utf16_len: usize,
    rule_id: &'static str,
}

#[derive(Debug, Clone, Copy)]
struct RuleSpec {
    capture_name: Option<&'static str>,
    category: FindingCategory,
    severity: FindingSeverity,
    rule_id: &'static str,
}

static PEM_RE: OnceLock<Regex> = OnceLock::new();
static AUTH_BEARER_HEADER_RE: OnceLock<Regex> = OnceLock::new();
static AUTH_BASIC_HEADER_RE: OnceLock<Regex> = OnceLock::new();
static AUTH_TOKEN_HEADER_RE: OnceLock<Regex> = OnceLock::new();
static BEARER_RE: OnceLock<Regex> = OnceLock::new();
static BASIC_RE: OnceLock<Regex> = OnceLock::new();
static API_KEY_RE: OnceLock<Regex> = OnceLock::new();
static API_KEY_ZH_RE: OnceLock<Regex> = OnceLock::new();
static DATABASE_URL_RE: OnceLock<Regex> = OnceLock::new();
static EMAIL_RE: OnceLock<Regex> = OnceLock::new();
static PHONE_RE: OnceLock<Regex> = OnceLock::new();
static NATIONAL_ID_RE: OnceLock<Regex> = OnceLock::new();
static NATIONAL_ID_CONTEXT_RE: OnceLock<Regex> = OnceLock::new();
static BANK_CARD_RE: OnceLock<Regex> = OnceLock::new();
static IPV4_RE: OnceLock<Regex> = OnceLock::new();
static COOKIE_HEADER_RE: OnceLock<Regex> = OnceLock::new();
static COOKIE_FIELD_RE: OnceLock<Regex> = OnceLock::new();
static SESSION_FIELD_RE: OnceLock<Regex> = OnceLock::new();

fn built_in_regex(cell: &'static OnceLock<Regex>, pattern: &'static str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("内建隐私规则必须是有效正则"))
}

fn trim_match(text: &str, mut start: usize, mut end: usize) -> (usize, usize) {
    while start < end {
        let ch = text[start..end].chars().next().unwrap();
        if ch.is_whitespace() || matches!(ch, '\'' | '"') {
            start += ch.len_utf8();
        } else {
            break;
        }
    }
    while start < end {
        let ch = text[start..end].chars().next_back().unwrap();
        if ch.is_whitespace() || matches!(ch, '\'' | '"' | '.' | ',' | ';' | ')' | ']' | '}') {
            end -= ch.len_utf8();
        } else {
            break;
        }
    }
    (start, end)
}

fn add_capture_candidates<F>(
    text: &str,
    regex: &Regex,
    spec: RuleSpec,
    validate: F,
    candidates: &mut Vec<Candidate>,
) where
    F: Fn(&str, usize, usize, &Captures<'_>) -> bool,
{
    for captures in regex.captures_iter(text) {
        let matched = spec
            .capture_name
            .and_then(|name| captures.name(name))
            .or_else(|| captures.get(0));
        let Some(matched) = matched else {
            continue;
        };
        let (start_byte, end_byte) = trim_match(text, matched.start(), matched.end());
        if start_byte >= end_byte {
            continue;
        }
        let value = &text[start_byte..end_byte];
        if validate(value, start_byte, end_byte, &captures) {
            candidates.push(Candidate {
                category: spec.category,
                severity: spec.severity,
                start_byte,
                end_byte,
                range_utf16_len: value.encode_utf16().count(),
                rule_id: spec.rule_id,
            });
        }
    }
}

fn always_valid(_: &str, _: usize, _: usize, _: &Captures<'_>) -> bool {
    true
}

fn token_boundary(text: &str, start: usize, end: usize, dot_is_token: bool) -> bool {
    let is_token =
        |ch: char| ch.is_ascii_alphanumeric() || ch == '_' || (dot_is_token && ch == '.');
    text[..start]
        .chars()
        .next_back()
        .is_none_or(|ch| !is_token(ch))
        && text[end..].chars().next().is_none_or(|ch| !is_token(ch))
}

fn nontrivial_secret(value: &str, _: usize, _: usize, _: &Captures<'_>) -> bool {
    if value.chars().count() < 12 {
        return false;
    }
    !matches!(
        value.to_ascii_lowercase().as_str(),
        "placeholder" | "your_api_key" | "your_secret" | "example_value" | "disabled"
    )
}

fn bearer_secret(value: &str, _: usize, _: usize, _: &Captures<'_>) -> bool {
    value.chars().count() >= 8
}

fn basic_secret(value: &str, _: usize, _: usize, _: &Captures<'_>) -> bool {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(value))
        .ok();
    decoded.is_some_and(|bytes| {
        bytes
            .iter()
            .position(|byte| *byte == b':')
            .is_some_and(|colon| colon > 0 && colon + 1 < bytes.len())
    })
}

fn pem_block(value: &str, _: usize, _: usize, captures: &Captures<'_>) -> bool {
    !value.is_empty()
        && captures.name("begin").map(|m| m.as_str()) == captures.name("end").map(|m| m.as_str())
}

fn valid_email(value: &str, _: usize, _: usize, _: &Captures<'_>) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    let tld = domain.rsplit('.').next().unwrap_or_default();
    !local.starts_with('.') && !local.ends_with('.') && !local.contains("..") && tld.len() >= 2
}

fn normalized_digits(value: &str) -> String {
    value.chars().filter(char::is_ascii_digit).collect()
}

fn valid_phone(value: &str, _: usize, _: usize, _: &Captures<'_>) -> bool {
    let digits = normalized_digits(value);
    let date_like = ['-', '.', '/'].into_iter().any(|separator| {
        let parts = value.split(separator).collect::<Vec<_>>();
        parts.len() == 3
            && parts[0].len() == 4
            && parts[1].len() <= 2
            && parts[2].len() <= 2
            && parts[0]
                .parse::<u32>()
                .ok()
                .zip(parts[1].parse::<u32>().ok())
                .zip(parts[2].parse::<u32>().ok())
                .is_some_and(|((year, month), day)| valid_gregorian_date(year, month, day))
    });
    !date_like
        && parse_ipv4(value).is_none()
        && (7..=15).contains(&digits.len())
        && digits
            .bytes()
            .any(|digit| Some(digit) != digits.as_bytes().first().copied())
}

fn valid_gregorian_date(year: u32, month: u32, day: u32) -> bool {
    if !(1800..=2100).contains(&year) || !(1..=12).contains(&month) {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=max_day).contains(&day)
}

fn valid_mainland_id(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    let bytes = upper.as_bytes();
    if bytes.len() != 18 || !bytes[..17].iter().all(u8::is_ascii_digit) {
        return false;
    }
    let year = upper[6..10].parse::<u32>().ok();
    let month = upper[10..12].parse::<u32>().ok();
    let day = upper[12..14].parse::<u32>().ok();
    if !year
        .zip(month)
        .zip(day)
        .is_some_and(|((year, month), day)| valid_gregorian_date(year, month, day))
        || &upper[14..17] == "000"
    {
        return false;
    }
    const WEIGHTS: [u32; 17] = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const CHECKS: [u8; 11] = *b"10X98765432";
    let sum = bytes[..17]
        .iter()
        .zip(WEIGHTS)
        .map(|(digit, weight)| u32::from(*digit - b'0') * weight)
        .sum::<u32>();
    bytes[17] == CHECKS[(sum % 11) as usize]
}

fn luhn_valid(value: &str, _: usize, _: usize, _: &Captures<'_>) -> bool {
    let digits = normalized_digits(value);
    if !(13..=19).contains(&digits.len())
        || digits.bytes().all(|digit| digit == digits.as_bytes()[0])
    {
        return false;
    }
    digits
        .bytes()
        .rev()
        .enumerate()
        .map(|(index, digit)| {
            let mut value = u32::from(digit - b'0');
            if index % 2 == 1 {
                value *= 2;
                if value > 9 {
                    value -= 9;
                }
            }
            value
        })
        .sum::<u32>()
        % 10
        == 0
}

fn parse_ipv4(value: &str) -> Option<[u8; 4]> {
    let octets = value
        .split('.')
        .map(str::parse::<u8>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    (octets.len() == 4).then(|| [octets[0], octets[1], octets[2], octets[3]])
}

fn is_private_ipv4(octets: [u8; 4]) -> bool {
    octets[0] == 10
        || octets[0] == 127
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
        || (octets[0] == 169 && octets[1] == 254)
}

fn placeholder(category: FindingCategory) -> &'static str {
    match category {
        FindingCategory::PrivateKey => "[PRIVATE_KEY]",
        FindingCategory::Authorization => "[AUTHORIZATION]",
        FindingCategory::ApiKey => "[API_KEY]",
        FindingCategory::DatabaseUrl => "[DATABASE_URL]",
        FindingCategory::Email => "[EMAIL]",
        FindingCategory::Phone => "[PHONE]",
        FindingCategory::NationalId => "[NATIONAL_ID]",
        FindingCategory::BankCard => "[BANK_CARD]",
        FindingCategory::IpAddress => "[IP_ADDRESS]",
        FindingCategory::Cookie => "[COOKIE]",
        FindingCategory::Session => "[SESSION]",
    }
}

fn masked_preview(value: &str) -> String {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return "••••".into();
    };
    let last = chars.next_back().unwrap_or(first);
    format!("{first}•••{last}")
}

fn category_name(category: FindingCategory) -> &'static str {
    match category {
        FindingCategory::PrivateKey => "privateKey",
        FindingCategory::Authorization => "authorization",
        FindingCategory::ApiKey => "apiKey",
        FindingCategory::DatabaseUrl => "databaseUrl",
        FindingCategory::Email => "email",
        FindingCategory::Phone => "phone",
        FindingCategory::NationalId => "nationalId",
        FindingCategory::BankCard => "bankCard",
        FindingCategory::IpAddress => "ipAddress",
        FindingCategory::Cookie => "cookie",
        FindingCategory::Session => "session",
    }
}

fn utf16_index(text: &str) -> Vec<u32> {
    let mut index = vec![0; text.len() + 1];
    let mut utf16 = 0_u32;
    for (byte, ch) in text.char_indices() {
        index[byte] = utf16;
        utf16 += ch.len_utf16() as u32;
    }
    index[text.len()] = utf16;
    index
}

fn collect_candidates(text: &str) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    add_capture_candidates(
        text,
        built_in_regex(
            &PEM_RE,
            r"(?s)-----BEGIN (?P<begin>(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY)-----.*?-----END (?P<end>(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY)-----",
        ),
        RuleSpec {
            capture_name: None,
            category: FindingCategory::PrivateKey,
            severity: FindingSeverity::Block,
            rule_id: "credential.pem_private_key",
        },
        pem_block,
        &mut candidates,
    );
    for (cell, pattern, rule_id, validator) in [
        (
            &AUTH_BEARER_HEADER_RE,
            r"(?im)^[ \t]*(?:proxy-)?authorization[ \t]*:[ \t]*bearer[ \t]+(?P<secret>[A-Za-z0-9][A-Za-z0-9._~+/=\-]{7,})[ \t]*$",
            "auth.authorization_header_bearer",
            bearer_secret as fn(&str, usize, usize, &Captures<'_>) -> bool,
        ),
        (
            &AUTH_BASIC_HEADER_RE,
            r"(?im)^[ \t]*(?:proxy-)?authorization[ \t]*:[ \t]*basic[ \t]+(?P<secret>[A-Za-z0-9+/]{8,}={0,2})[ \t]*$",
            "auth.authorization_header_basic",
            basic_secret,
        ),
        (
            &AUTH_TOKEN_HEADER_RE,
            r"(?im)^[ \t]*(?:proxy-)?authorization[ \t]*:[ \t]*(?:token|apikey)[ \t]+(?P<secret>[A-Za-z0-9][A-Za-z0-9._~+/=\-]{7,})[ \t]*$",
            "auth.authorization_header_token",
            bearer_secret,
        ),
        (
            &BEARER_RE,
            r"(?i)\bbearer[ \t]+(?P<secret>[A-Za-z0-9][A-Za-z0-9._~+/=\-]{7,})",
            "auth.bearer",
            bearer_secret,
        ),
        (
            &BASIC_RE,
            r"(?i)\bbasic[ \t]+(?P<secret>[A-Za-z0-9+/]{8,}={0,2})",
            "auth.basic",
            basic_secret,
        ),
    ] {
        add_capture_candidates(
            text,
            built_in_regex(cell, pattern),
            RuleSpec {
                capture_name: Some("secret"),
                category: FindingCategory::Authorization,
                severity: FindingSeverity::Block,
                rule_id,
            },
            validator,
            &mut candidates,
        );
    }
    for (cell, pattern, rule_id) in [
        (
            &API_KEY_RE,
            r#"(?i)\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|secret(?:[_ -]?key)?)\b["']?[ \t]*[:=][ \t]*["']?(?P<secret>[A-Za-z0-9][A-Za-z0-9._~+/=\-]{11,})"#,
            "token.contextual_secret",
        ),
        (
            &API_KEY_ZH_RE,
            r#"(?:API[ \t]*密钥|访问令牌|客户端密钥|密钥)["']?[ \t]*[:：=][ \t]*["']?(?P<secret>[A-Za-z0-9][A-Za-z0-9._~+/=\-]{11,})"#,
            "token.contextual_secret_zh",
        ),
    ] {
        add_capture_candidates(
            text,
            built_in_regex(cell, pattern),
            RuleSpec {
                capture_name: Some("secret"),
                category: FindingCategory::ApiKey,
                severity: FindingSeverity::Block,
                rule_id,
            },
            nontrivial_secret,
            &mut candidates,
        );
    }
    add_capture_candidates(
        text,
        built_in_regex(
            &DATABASE_URL_RE,
            r#"(?i)\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?)://[^:/?#@\s]+:[^/?#@\s]+@[^/?#\s"'<>()]+(?::[0-9]{1,5})?(?:/[^\s"'<>()]*)?"#,
        ),
        RuleSpec {
            capture_name: None,
            category: FindingCategory::DatabaseUrl,
            severity: FindingSeverity::Block,
            rule_id: "credential.database_url",
        },
        always_valid,
        &mut candidates,
    );
    add_capture_candidates(
        text,
        built_in_regex(
            &EMAIL_RE,
            r#"(?i)\b(?P<secret>[A-Z0-9.!#$%&'*+/=?^_`{|}~\-]+@[A-Z0-9](?:[A-Z0-9\-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9\-]{0,61}[A-Z0-9])?)+)\b"#,
        ),
        RuleSpec {
            capture_name: Some("secret"),
            category: FindingCategory::Email,
            severity: FindingSeverity::Warn,
            rule_id: "contact.email",
        },
        valid_email,
        &mut candidates,
    );
    add_capture_candidates(
        text,
        built_in_regex(
            &PHONE_RE,
            r#"(?i)(?:\b(?:phone|tel(?:ephone)?|mobile)(?:[ \t._-]*number)?\b|(?:电话|手机|联系电话)(?:号码|号)?)["']?[ \t]*[:：=]?[ \t]*["']?(?P<secret>\+?[0-9][0-9() .\-]{5,22}[0-9])"#,
        ),
        RuleSpec {
            capture_name: Some("secret"),
            category: FindingCategory::Phone,
            severity: FindingSeverity::Warn,
            rule_id: "contact.phone_context",
        },
        valid_phone,
        &mut candidates,
    );
    add_capture_candidates(
        text,
        built_in_regex(&NATIONAL_ID_RE, r"(?P<secret>[1-9][0-9]{16}[0-9Xx])"),
        RuleSpec {
            capture_name: Some("secret"),
            category: FindingCategory::NationalId,
            severity: FindingSeverity::Warn,
            rule_id: "identity.cn_mainland_id",
        },
        |value, start, end, _| token_boundary(text, start, end, false) && valid_mainland_id(value),
        &mut candidates,
    );
    // 显式「身份证」标签下放宽结构校验：抄错一位的真实证号同样是隐私泄露。
    add_capture_candidates(
        text,
        built_in_regex(
            &NATIONAL_ID_CONTEXT_RE,
            r#"身份证(?:号码|号)?["']?[ \t]*[:：=]?[ \t]*["']?(?P<secret>[0-9]{17}[0-9Xx]|[0-9]{15})"#,
        ),
        RuleSpec {
            capture_name: Some("secret"),
            category: FindingCategory::NationalId,
            severity: FindingSeverity::Warn,
            rule_id: "identity.cn_mainland_id_context",
        },
        |value, start, end, _| {
            token_boundary(text, start, end, false)
                && value
                    .bytes()
                    .any(|digit| digit != value.as_bytes()[0])
        },
        &mut candidates,
    );
    add_capture_candidates(
        text,
        built_in_regex(
            &BANK_CARD_RE,
            r#"(?i)(?:\b(?:bank[_ \t-]*card|credit[_ \t-]*card|debit[_ \t-]*card|card(?:[_ \t-]*number)?)\b|银行卡|卡号)["']?[ \t]*[:：#=]?[ \t]*["']?(?P<secret>[0-9][0-9 \-]{11,25}[0-9])"#,
        ),
        RuleSpec {
            capture_name: Some("secret"),
            category: FindingCategory::BankCard,
            severity: FindingSeverity::Warn,
            rule_id: "financial.bank_card_luhn",
        },
        luhn_valid,
        &mut candidates,
    );
    let ipv4_regex = built_in_regex(&IPV4_RE, r"(?P<secret>(?:[0-9]{1,3}\.){3}[0-9]{1,3})");
    for captures in ipv4_regex.captures_iter(text) {
        let matched = captures.name("secret").unwrap();
        if !token_boundary(text, matched.start(), matched.end(), true) {
            continue;
        }
        let Some(octets) = parse_ipv4(matched.as_str()) else {
            continue;
        };
        candidates.push(Candidate {
            category: FindingCategory::IpAddress,
            severity: FindingSeverity::Warn,
            start_byte: matched.start(),
            end_byte: matched.end(),
            range_utf16_len: matched.as_str().encode_utf16().count(),
            rule_id: if is_private_ipv4(octets) {
                "network.ipv4_private"
            } else {
                "network.ipv4_public"
            },
        });
    }
    for (cell, pattern, category, rule_id) in [
        (
            &COOKIE_HEADER_RE,
            r"(?im)^[ \t]*(?:set-cookie|cookie)[ \t]*:[ \t]*(?P<secret>[^\r\n]{6,})",
            FindingCategory::Cookie,
            "session.cookie_header",
        ),
        (
            &COOKIE_FIELD_RE,
            r#"(?i)\b(?:auth[_ -]?cookie|cookie(?:[_ -]?value)?)\b["']?[ \t]*[:=][ \t]*["']?(?P<secret>[A-Za-z0-9][A-Za-z0-9._~+/%=\-]{11,})"#,
            FindingCategory::Cookie,
            "session.cookie_field",
        ),
        (
            &SESSION_FIELD_RE,
            r#"(?i)\b(?:session(?:[_ -]?(?:id|token))?|jsessionid|connect\.sid|sid)\b["']?[ \t]*[:=][ \t]*["']?(?P<secret>[A-Za-z0-9][A-Za-z0-9._~+/%=\-]{11,})"#,
            FindingCategory::Session,
            "session.explicit_field",
        ),
    ] {
        add_capture_candidates(
            text,
            built_in_regex(cell, pattern),
            RuleSpec {
                capture_name: Some("secret"),
                category,
                severity: FindingSeverity::Block,
                rule_id,
            },
            nontrivial_secret,
            &mut candidates,
        );
    }
    candidates
}

fn resolve_overlaps(mut candidates: Vec<Candidate>) -> Vec<Candidate> {
    candidates.sort_by(|left, right| {
        right
            .severity
            .cmp(&left.severity)
            .then_with(|| right.range_utf16_len.cmp(&left.range_utf16_len))
            .then_with(|| left.rule_id.cmp(right.rule_id))
            .then_with(|| left.start_byte.cmp(&right.start_byte))
    });
    let mut accepted_ranges = BTreeMap::<usize, usize>::new();
    let mut accepted = Vec::new();
    for candidate in candidates {
        let overlaps = accepted_ranges
            .range(..candidate.end_byte)
            .next_back()
            .is_some_and(|(_, end)| *end > candidate.start_byte);
        if !overlaps {
            accepted_ranges.insert(candidate.start_byte, candidate.end_byte);
            accepted.push(candidate);
        }
    }
    accepted.sort_by(|left, right| {
        left.start_byte
            .cmp(&right.start_byte)
            .then_with(|| left.end_byte.cmp(&right.end_byte))
            .then_with(|| left.rule_id.cmp(right.rule_id))
    });
    accepted
}

pub fn scan_sensitive_text(request: ScanSensitiveRequest) -> ScanSensitiveResult {
    let input_utf16 = request.text.encode_utf16().count();
    if request.text.len() > MAX_SCAN_INPUT_BYTES {
        return ScanSensitiveResult {
            findings: Vec::new(),
            warnings: vec![ScanWarning {
                code: ScanWarningCode::InputTooLong,
                message: format!(
                    "文本超过本地扫描上限（{} 字节），未执行不完整扫描",
                    MAX_SCAN_INPUT_BYTES
                ),
                max_bytes: MAX_SCAN_INPUT_BYTES,
                actual_bytes: request.text.len(),
            }],
            input_utf16,
            scanned_utf16: 0,
            complete: false,
        };
    }
    let utf16 = utf16_index(&request.text);
    let findings = resolve_overlaps(collect_candidates(&request.text))
        .into_iter()
        .map(|candidate| {
            let start_utf16 = utf16[candidate.start_byte] as usize;
            let end_utf16 = utf16[candidate.end_byte] as usize;
            let value = &request.text[candidate.start_byte..candidate.end_byte];
            FirewallFinding {
                id: format!("{}:{start_utf16}:{end_utf16}", candidate.rule_id),
                category: candidate.category,
                severity: candidate.severity,
                start_utf16,
                end_utf16,
                masked_preview: masked_preview(value),
                suggested_placeholder: placeholder(candidate.category).into(),
                rule_id: candidate.rule_id.into(),
            }
        })
        .collect();
    ScanSensitiveResult {
        findings,
        warnings: Vec::new(),
        input_utf16,
        scanned_utf16: input_utf16,
        complete: true,
    }
}

pub fn diagnostic_summary(result: &ScanSensitiveResult, elapsed: Duration) -> String {
    let mut counts = HashMap::<&'static str, usize>::new();
    for finding in &result.findings {
        *counts.entry(category_name(finding.category)).or_default() += 1;
    }
    let mut categories = counts.into_iter().collect::<Vec<_>>();
    categories.sort_unstable_by_key(|(category, _)| *category);
    let categories = if categories.is_empty() {
        "none".into()
    } else {
        categories
            .into_iter()
            .map(|(category, count)| format!("{category}:{count}"))
            .collect::<Vec<_>>()
            .join(",")
    };
    format!(
        "隐私扫描: utf16={} findings={} categories={} elapsed_ms={}",
        result.input_utf16,
        result.findings.len(),
        categories,
        elapsed.as_millis()
    )
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    fn scan(text: impl Into<String>) -> ScanSensitiveResult {
        scan_sensitive_text(ScanSensitiveRequest { text: text.into() })
    }

    fn has_category(result: &ScanSensitiveResult, category: FindingCategory) -> bool {
        result
            .findings
            .iter()
            .any(|finding| finding.category == category)
    }

    fn assert_rule_cases(category: FindingCategory, positives: &[String], negatives: &[&str]) {
        assert!(positives.len() >= 5);
        assert!(negatives.len() >= 5);
        for text in positives {
            let result = scan(text);
            assert!(
                has_category(&result, category),
                "expected {category:?} for {text:?}, got {:?}",
                result.findings
            );
        }
        for text in negatives {
            let result = scan(*text);
            assert!(
                !has_category(&result, category),
                "unexpected {category:?} for {text:?}: {:?}",
                result.findings
            );
        }
    }

    #[test]
    fn private_key_rule_has_five_positive_and_negative_cases() {
        let positives = ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "]
            .map(|kind| {
                format!(
                    "-----BEGIN {kind}PRIVATE KEY-----\nYWJjZGVmZ2hpamtsbW5vcA==\n-----END {kind}PRIVATE KEY-----"
                )
            });
        assert_rule_cases(
            FindingCategory::PrivateKey,
            &positives,
            &[
                "-----BEGIN PUBLIC KEY-----\nYWJj\n-----END PUBLIC KEY-----",
                "-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----",
                "-----BEGIN PRIVATE KEY-----\nYWJj",
                "BEGIN PRIVATE KEY: documentation only",
                "-----BEGIN RSA PRIVATE KEY-----\nYWJj\n-----END EC PRIVATE KEY-----",
            ],
        );
    }

    #[test]
    fn authorization_rules_have_five_positive_and_negative_cases() {
        assert_rule_cases(
            FindingCategory::Authorization,
            &[
                "Authorization: Bearer abcdefghijklmnop".into(),
                "Proxy-Authorization: Basic dXNlcjpwYXNz".into(),
                "Bearer ghp_abcdefghijklmnopqrstuvwxyz".into(),
                "Basic YWRtaW46czNjcjN0".into(),
                "Authorization: Token token_value_123456".into(),
            ],
            &[
                "Bearer short",
                "Basic dXNlcm5hbWU=",
                "Authorization: Bearer",
                "Authorization header is documented here",
                "Basic plan costs ten dollars",
            ],
        );
    }

    #[test]
    fn api_key_rules_have_five_positive_and_negative_cases() {
        assert_rule_cases(
            FindingCategory::ApiKey,
            &[
                r#""api_key": "sk_test_1234567890""#.into(),
                "accessToken: abcdefghijklmnop".into(),
                "client-secret = supersecretvalue123".into(),
                "API 密钥：cn_secret_123456789".into(),
                "访问令牌 = token_value_abcdefgh".into(),
            ],
            &[
                "api_key = short",
                "secret: disabled",
                "token count = 12",
                "not_api_key = abcdefghijklmnop",
                "the secret garden is a book",
            ],
        );
    }

    #[test]
    fn database_url_rules_have_five_positive_and_negative_cases() {
        assert_rule_cases(
            FindingCategory::DatabaseUrl,
            &[
                "postgres://alice:p%40ss@db.example.com/app".into(),
                "mysql://root:s3cret@127.0.0.1:3306/main".into(),
                "mongodb+srv://user:pass%3Aword@cluster.example.net/db".into(),
                "rediss://cache:token123@redis.example.com/0".into(),
                "amqps://worker:qwerty123@mq.example.com/vhost".into(),
            ],
            &[
                "postgres://alice@db.example.com/app",
                "postgres://:secret@db.example.com/app",
                "https://alice:secret@example.com/",
                "postgres://alice:@db.example.com/app",
                "database URL example without credentials",
            ],
        );
    }

    #[test]
    fn email_rules_have_five_positive_and_negative_cases() {
        assert_rule_cases(
            FindingCategory::Email,
            &[
                "alice@example.com".into(),
                "first.last+tag@sub.example.co.uk".into(),
                "USER_01@EXAMPLE.ORG".into(),
                "联系邮箱：dev-team@company.cn".into(),
                "mail=a-b.c@example.io".into(),
            ],
            &[
                "alice@example",
                "@example.com",
                "alice..smith@example.com",
                "alice@example.c",
                "alice @ example.com",
            ],
        );
    }

    #[test]
    fn phone_rules_have_five_positive_and_negative_cases() {
        assert_rule_cases(
            FindingCategory::Phone,
            &[
                "手机：13800138000".into(),
                "电话: +86 139 1234 5678".into(),
                r#""phone": "+1 (415) 555-2671""#.into(),
                "tel: 010-88886666".into(),
                "联系电话：0755 1234 5678".into(),
                "手机号：18888888888".into(),
                "电话号码: 13912345678".into(),
                "phone number: +1 415 555 2671".into(),
            ],
            &[
                "订单号 13800138000",
                "编号：13800138000",
                "phone: 12345",
                "日期 2026-08-11",
                "phone: 2026-08-11",
                "tel: 192.168.1.1",
                "版本 10.20.30.40",
                "telephone support is unavailable",
            ],
        );
    }

    fn with_cn_checksum(prefix17: &str) -> String {
        const WEIGHTS: [u32; 17] = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
        const CHECKS: [char; 11] = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
        assert_eq!(prefix17.len(), 17);
        let sum = prefix17
            .bytes()
            .zip(WEIGHTS)
            .map(|(digit, weight)| u32::from(digit - b'0') * weight)
            .sum::<u32>();
        format!("{prefix17}{}", CHECKS[(sum % 11) as usize])
    }

    #[test]
    fn mainland_id_rules_have_five_positive_and_negative_cases() {
        let mut positives = [
            "11010519491231002",
            "44052419800101001",
            "32031119770706001",
            "51010519900307001",
            "31010120000101002",
        ]
        .map(|prefix| format!("身份证：{}", with_cn_checksum(prefix)))
        .to_vec();
        // 显式「身份证」标签下即使日期段/校验位无效也要告警（可能是抄错一位的真实证号）。
        positives.push("身份证号：411381188826261218".into());
        positives.push("身份证号码: 110105194912310021".into());
        assert_rule_cases(
            FindingCategory::NationalId,
            &positives,
            &[
                "110105194912310021",
                "110105199902300021",
                "01010519900101001X",
                "1101051990010100100",
                "身份证号码将在这里显示",
                "身份证号：111111111111111111",
            ],
        );
    }

    #[test]
    fn bank_card_rules_have_five_positive_and_negative_cases() {
        assert_rule_cases(
            FindingCategory::BankCard,
            &[
                "银行卡：4111 1111 1111 1111".into(),
                r#""card_number": "5555-5555-5555-4444""#.into(),
                "credit card: 378282246310005".into(),
                "debit card 6011111111111117".into(),
                "卡号：4012888888881881".into(),
            ],
            &[
                "银行卡：4111 1111 1111 1112",
                "card number=123456789012",
                "reference 4111111111111111",
                "卡号：0000000000000000",
                "credit card ending in 1881",
            ],
        );
    }

    #[test]
    fn ipv4_rules_have_five_positive_and_negative_cases() {
        assert_rule_cases(
            FindingCategory::IpAddress,
            &[
                "10.0.0.1".into(),
                "172.16.8.9".into(),
                "192.168.1.10".into(),
                "8.8.8.8".into(),
                "server=169.254.2.3".into(),
            ],
            &[
                "256.1.1.1",
                "1.2.3",
                "1.2.3.4.5",
                "version1.2.3.4beta",
                "999.999.999.999",
            ],
        );
    }

    #[test]
    fn cookie_rules_have_five_positive_and_negative_cases() {
        assert_rule_cases(
            FindingCategory::Cookie,
            &[
                "Cookie: auth=abcdefghijklmnop".into(),
                "Set-Cookie: sid=abcdefghijklmnop; HttpOnly".into(),
                r#""cookie": "abcdefghijklmnop""#.into(),
                "auth_cookie: cookie_value_123456".into(),
                "cookieValue=abcdefghijklmnop".into(),
            ],
            &[
                "cookie=true",
                "cookie recipe uses butter",
                "Set-Cookie:",
                "cookie = short",
                "cookies accepted",
            ],
        );
    }

    #[test]
    fn session_rules_have_five_positive_and_negative_cases() {
        assert_rule_cases(
            FindingCategory::Session,
            &[
                r#""session_id": "abcdefghijklmnop""#.into(),
                "sessionToken: token_value_123456".into(),
                "JSESSIONID=abcdefghijklmnop".into(),
                "connect.sid=session_value_12345".into(),
                "sid: abcdefghijklmnop".into(),
            ],
            &[
                "session_id = short",
                "session timeout = 30",
                "sid: 1234",
                "session documentation",
                "JSESSIONID is a field name",
            ],
        );
    }

    #[test]
    fn utf16_offsets_slice_cjk_emoji_and_combining_text_exactly() {
        let prefix = "中文😀e\u{301} 前缀 ";
        let email = "alice@example.com";
        let text = format!("{prefix}{email} 后缀");
        let result = scan(&text);
        let finding = result
            .findings
            .iter()
            .find(|finding| finding.category == FindingCategory::Email)
            .unwrap();
        assert_eq!(finding.start_utf16, prefix.encode_utf16().count());
        let units = text.encode_utf16().collect::<Vec<_>>();
        assert_eq!(
            String::from_utf16(&units[finding.start_utf16..finding.end_utf16]).unwrap(),
            email
        );
    }

    #[test]
    fn overlap_priority_and_final_order_are_deterministic() {
        let overlapping = scan("Cookie: session_id=abcdefghijklmnop");
        assert_eq!(overlapping.findings.len(), 1);
        assert_eq!(overlapping.findings[0].category, FindingCategory::Cookie);

        let severity_overlap = scan("postgres://alice:password@db.example.com/app");
        assert_eq!(severity_overlap.findings.len(), 1);
        assert_eq!(
            severity_overlap.findings[0].category,
            FindingCategory::DatabaseUrl
        );

        let rule_id_tie = scan("Authorization: Bearer abcdefghijklmnop");
        assert_eq!(rule_id_tie.findings.len(), 1);
        assert_eq!(
            rule_id_tie.findings[0].rule_id,
            "auth.authorization_header_bearer"
        );

        let text = "alice@example.com\napi_key=abcdefghijklmnop\n10.0.0.1";
        let first = scan(text);
        let second = scan(text);
        assert_eq!(first, second);
        assert!(first
            .findings
            .windows(2)
            .all(|pair| pair[0].start_utf16 <= pair[1].start_utf16));
    }

    #[test]
    fn block_findings_never_serialize_the_full_secret() {
        let secret = "super_secret_value_123456789";
        let result = scan(format!("api_key={secret}"));
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains(secret));
        let finding = result.findings.first().unwrap();
        assert_eq!(finding.severity, FindingSeverity::Block);
        assert_eq!(finding.suggested_placeholder, "[API_KEY]");
    }

    #[test]
    fn oversize_empty_and_replacement_character_inputs_are_safe() {
        let oversized = scan("x".repeat(MAX_SCAN_INPUT_BYTES + 1));
        assert!(!oversized.complete);
        assert_eq!(oversized.scanned_utf16, 0);
        assert_eq!(oversized.warnings.len(), 1);
        assert_eq!(oversized.warnings[0].code, ScanWarningCode::InputTooLong);

        let empty = scan("");
        assert!(empty.complete);
        assert!(empty.findings.is_empty());
        assert!(scan("prefix \u{fffd} api_key=abcdefghijklmnop").complete);
    }

    #[test]
    fn serde_contract_is_camel_case() {
        let result = scan("alice@example.com");
        let json = serde_json::to_value(result).unwrap();
        let finding = &json["findings"][0];
        assert_eq!(finding["category"], "email");
        assert_eq!(finding["severity"], "warn");
        assert!(finding.get("startUtf16").is_some());
        assert!(finding.get("endUtf16").is_some());
        assert!(finding.get("maskedPreview").is_some());
        assert!(finding.get("suggestedPlaceholder").is_some());
        assert!(finding.get("ruleId").is_some());
        assert!(json.get("inputUtf16").is_some());
        assert!(json.get("scannedUtf16").is_some());

        let warning = serde_json::to_value(scan("x".repeat(MAX_SCAN_INPUT_BYTES + 1))).unwrap();
        assert_eq!(warning["warnings"][0]["code"], "inputTooLong");
        assert!(warning["warnings"][0].get("maxBytes").is_some());
        assert!(warning["warnings"][0].get("actualBytes").is_some());
    }

    #[test]
    fn diagnostics_include_only_counts_and_elapsed_time() {
        let secret = "diagnostic_secret_123456";
        let result = scan(format!("api_key={secret}\nalice@example.com"));
        let summary = diagnostic_summary(&result, Duration::from_millis(7));
        assert!(summary.contains("findings=2"));
        assert!(summary.contains("elapsed_ms=7"));
        assert!(summary.contains("apiKey:1"));
        assert!(summary.contains("email:1"));
        assert!(!summary.contains(secret));
        assert!(!summary.contains("alice@example.com"));
    }

    #[test]
    fn one_mib_mixed_text_stays_within_reference_budget() {
        let chunk = "普通文本 alpha beta gamma 😀 e\u{301}\n";
        let mut text = String::with_capacity(1_048_576);
        while text.len() + chunk.len() < 1_048_000 {
            text.push_str(chunk);
        }
        text.push_str("\napi_key=performance_secret_123456\nalice@example.com");
        let started = Instant::now();
        let result = scan(text);
        let elapsed = started.elapsed();
        eprintln!(
            "privacy 1 MiB reference scan: {:.2}ms",
            elapsed.as_secs_f64() * 1_000.0
        );
        assert!(result.complete);
        assert!(result.findings.len() >= 2);
        assert!(
            elapsed < Duration::from_millis(750),
            "1 MiB scan exceeded 750ms reference budget: {elapsed:?}"
        );
    }
}
