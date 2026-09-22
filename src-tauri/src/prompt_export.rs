//! 独立模板 JSON 导出，不读取应用数据目录或密钥。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PromptTemplatesExport {
    format: String,
    version: u32,
    groups: Vec<PromptGroup>,
    snippets: Vec<PromptSnippet>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PromptGroup {
    id: String,
    name: String,
    order: serde_json::Number,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PromptSnippet {
    id: String,
    label: String,
    text: String,
    group_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_common_flag"
    )]
    is_common: Option<bool>,
}

// 缺省保留旧模板语义；显式 null 与其他非布尔值都不是合法覆盖。
fn deserialize_common_flag<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<bool>, D::Error> {
    bool::deserialize(deserializer).map(Some)
}

pub fn export_prompt_templates(
    destination: &Path,
    mut payload: PromptTemplatesExport,
) -> Result<(), String> {
    if !destination.is_absolute()
        || !destination
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return Err("模板导出目标必须是绝对 .json 文件路径".into());
    }
    if std::fs::symlink_metadata(destination)
        .is_ok_and(|metadata| !metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err("模板导出目标不是普通文件".into());
    }
    if payload.format != "toskr-prompt-templates" || payload.version != 1 {
        return Err("模板导出格式或版本无效".into());
    }
    let referenced_groups: HashSet<_> =
        payload.snippets.iter().map(|item| &item.group_id).collect();
    payload
        .groups
        .retain(|group| referenced_groups.contains(&group.id));
    if referenced_groups
        .iter()
        .any(|id| !payload.groups.iter().any(|group| &group.id == *id))
    {
        return Err("模板引用的分组不存在".into());
    }
    let mut json = serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    json.push('\n');
    crate::data_integrity::atomic_write_file(
        destination,
        json.as_bytes(),
        crate::data_integrity::DataOperationFailureCode::WriteFailed,
    )
    .map_err(|error| error.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};
    use tempfile::tempdir;

    fn payload() -> serde_json::Value {
        json!({
            "format": "toskr-prompt-templates", "version": 1,
            "groups": [
                {"id": "project", "name": "项目", "order": 2},
                {"id": "unused", "name": "未引用", "order": 3}
            ],
            "snippets": [
                {"id": "mine", "label": "我的模板", "text": "原始正文\n\n{内容}", "groupId": "project"}
            ]
        })
    }

    #[test]
    fn exports_only_templates_and_referenced_groups_atomically() {
        let root = tempdir().unwrap();
        let path = root.path().join("templates.json");
        fs::write(&path, "old export").unwrap();
        export_prompt_templates(&path, serde_json::from_value(payload()).unwrap()).unwrap();
        let exported: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let mut expected = payload();
        expected["groups"].as_array_mut().unwrap().pop();
        assert_eq!(exported, expected);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn rejects_settings_notes_keys_and_extra_nested_fields() {
        for field in ["settings", "notes", "aiApiKey", "secretKeys"] {
            let mut value = payload();
            value[field] = json!("must not export");
            assert!(serde_json::from_value::<PromptTemplatesExport>(value).is_err());
        }
        for field in ["groups", "snippets"] {
            let mut value = payload();
            value[field][0]["aiApiKey"] = json!("must not export");
            assert!(serde_json::from_value::<PromptTemplatesExport>(value).is_err());
        }
    }

    #[test]
    fn exports_explicit_common_flags_and_omits_legacy_missing_flag() {
        let root = tempdir().unwrap();
        let path = root.path().join("templates.json");
        for flag in [None, Some(true), Some(false)] {
            let mut value = payload();
            if let Some(flag) = flag {
                value["snippets"][0]["isCommon"] = json!(flag);
            }
            export_prompt_templates(&path, serde_json::from_value(value).unwrap()).unwrap();
            let exported: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(exported["version"], json!(1));
            assert_eq!(
                exported["snippets"][0].get("isCommon"),
                flag.map(|flag| json!(flag)).as_ref()
            );
        }
    }

    #[test]
    fn rejects_non_boolean_common_flags() {
        for invalid in [json!(null), json!("false"), json!(0), json!([]), json!({})] {
            let mut value = payload();
            value["snippets"][0]["isCommon"] = invalid;
            assert!(serde_json::from_value::<PromptTemplatesExport>(value).is_err());
        }
    }

    #[test]
    fn rejects_invalid_format_missing_groups_and_non_json_paths() {
        let root = tempdir().unwrap();
        let path = root.path().join("templates.json");
        for (field, invalid) in [
            ("format", json!("toskr-backup")),
            ("version", json!(2)),
            ("groups", json!([])),
        ] {
            let mut value = payload();
            value[field] = invalid;
            assert!(
                export_prompt_templates(&path, serde_json::from_value(value).unwrap()).is_err()
            );
        }
        for invalid_path in [
            Path::new("relative.json"),
            &root.path().join("templates.txt"),
        ] {
            assert!(export_prompt_templates(
                invalid_path,
                serde_json::from_value(payload()).unwrap()
            )
            .is_err());
        }
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_replace_symlinks_or_their_target() {
        let root = tempdir().unwrap();
        let original = root.path().join("original.json");
        fs::write(&original, "keep").unwrap();
        let path = root.path().join("templates.json");
        symlink(&original, &path).unwrap();
        assert!(
            export_prompt_templates(&path, serde_json::from_value(payload()).unwrap()).is_err()
        );
        assert_eq!(fs::read_to_string(original).unwrap(), "keep");
    }
}
