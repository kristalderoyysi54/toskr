//! 数据密钥与 AI 记录共用固定的内置 helper。发布版没有直接读取钥匙串的回退：
//! helper 损坏/被替换时拒绝访问，避免升级时重新以主程序身份索取授权。

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::Mutex;

static ACCESS_LOCK: Mutex<()> = Mutex::new(());
const MAX_FRAME: usize = 64 * 1024;
const NOT_FOUND: i32 = -25300;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Slot {
    Data,
    Ai,
}

#[derive(Debug)]
pub enum BrokerError {
    Unavailable,
    Untrusted,
    InvalidResponse,
    Keychain(i32),
}

impl fmt::Display for BrokerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "内置密钥服务不可用，请重新安装完整的 Toskr 应用",
            Self::Untrusted => "内置密钥服务身份校验失败，已停止访问钥匙串",
            Self::InvalidResponse => "内置密钥服务返回无效数据",
            Self::Keychain(-128) => "已取消钥匙串授权；需要使用时可重试",
            Self::Keychain(_) => "无法访问 macOS 钥匙串；请解锁或允许 Toskr 密钥服务后重试",
        })
    }
}

#[derive(Serialize)]
struct Request<'a> {
    version: u8,
    slot: Slot,
    operation: &'a str,
    interactive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    status: i32,
    value: Option<String>,
}

pub fn load(slot: Slot) -> Result<Option<Vec<u8>>, BrokerError> {
    let response = request(Request {
        version: 1,
        slot,
        operation: "load",
        interactive: true,
        value: None,
    })?;
    decode_load(slot, response)
}

fn decode_load(slot: Slot, response: Response) -> Result<Option<Vec<u8>>, BrokerError> {
    if response.status == NOT_FOUND && response.value.is_none() {
        return Ok(None);
    }
    if response.status != 0 {
        return Err(BrokerError::Keychain(response.status));
    }
    let bytes = STANDARD
        .decode(response.value.ok_or(BrokerError::InvalidResponse)?)
        .map_err(|_| BrokerError::InvalidResponse)?;
    validate_value(slot, &bytes)?;
    Ok(Some(bytes))
}

pub fn store(slot: Slot, bytes: &[u8]) -> Result<(), BrokerError> {
    validate_value(slot, bytes)?;
    let response = request(Request {
        version: 1,
        slot,
        operation: "store",
        interactive: true,
        value: Some(STANDARD.encode(bytes)),
    })?;
    if response.status != 0 {
        return Err(BrokerError::Keychain(response.status));
    }
    if response.value.is_some() {
        return Err(BrokerError::InvalidResponse);
    }
    Ok(())
}

fn validate_value(slot: Slot, bytes: &[u8]) -> Result<(), BrokerError> {
    let valid = match slot {
        Slot::Data => bytes.len() == 32,
        Slot::Ai => !bytes.is_empty() && bytes.len() <= 32 * 1024,
    };
    if valid {
        Ok(())
    } else {
        Err(BrokerError::InvalidResponse)
    }
}

fn request(input: Request<'_>) -> Result<Response, BrokerError> {
    // 两类密钥不会同时弹授权；已经授权时 helper 的无交互请求直接返回。
    let _guard = ACCESS_LOCK.lock().map_err(|_| BrokerError::Unavailable)?;
    #[cfg(debug_assertions)]
    {
        development_request(input)
    }
    #[cfg(not(debug_assertions))]
    {
        native::request(input)
    }
}

// tauri dev 没有发布签名，无法冒充 com.toskr.app 调用 helper。
// 仅调试构建保留原开发路径；发布版不会因任何 helper 错误退回主进程取密钥。
#[cfg(debug_assertions)]
fn development_request(input: Request<'_>) -> Result<Response, BrokerError> {
    use security_framework::passwords::{get_generic_password, set_generic_password};
    let (service, account) = match input.slot {
        Slot::Data => ("com.toskr.app.data", "data-encryption-key-v1"),
        Slot::Ai => ("com.toskr.app.ai", "openai-compatible"),
    };
    if input.operation == "load" {
        Ok(match get_generic_password(service, account) {
            Ok(bytes) => Response {
                status: 0,
                value: Some(STANDARD.encode(bytes)),
            },
            Err(error) => Response {
                status: error.code(),
                value: None,
            },
        })
    } else {
        let bytes = STANDARD
            .decode(input.value.ok_or(BrokerError::InvalidResponse)?)
            .map_err(|_| BrokerError::InvalidResponse)?;
        let status = set_generic_password(service, account, &bytes)
            .err()
            .map(|error| error.code())
            .unwrap_or(0);
        Ok(Response {
            status,
            value: None,
        })
    }
}

// 编译测试也检查发布传输代码，但单元测试绝不访问真实钥匙串。
#[cfg_attr(debug_assertions, allow(dead_code))]
mod native {
    use super::*;
    use core_foundation::{base::TCFType, data::CFData};
    use security_framework::os::macos::code_signing::{
        Flags, GuestAttributes, SecCode, SecRequirement,
    };
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, OwnedFd};
    use std::os::unix::net::UnixStream;
    use std::process::{Child, Command, Stdio};
    use std::str::FromStr;
    use std::time::Duration;

    const HELLO: &[u8; 8] = b"TSKKEY01";

    struct Helper(Child);
    impl Drop for Helper {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    pub(super) fn request(input: Request<'_>) -> Result<Response, BrokerError> {
        let main = std::env::current_exe().map_err(|_| BrokerError::Unavailable)?;
        let contents = main
            .parent()
            .and_then(|p| p.parent())
            .ok_or(BrokerError::Unavailable)?;
        if contents.file_name().and_then(|s| s.to_str()) != Some("Contents") {
            return Err(BrokerError::Unavailable);
        }
        let path = contents.join("Helpers/toskr-keychain-helper");
        let (mut stream, child_stream) =
            UnixStream::pair().map_err(|_| BrokerError::Unavailable)?;
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| BrokerError::Unavailable)?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| BrokerError::Unavailable)?;
        let output: OwnedFd = child_stream
            .try_clone()
            .map_err(|_| BrokerError::Unavailable)?
            .into();
        let input_fd: OwnedFd = child_stream.into();
        let mut child = Helper(
            Command::new(path)
                .env_clear()
                .stdin(Stdio::from(input_fd))
                .stdout(Stdio::from(output))
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| BrokerError::Unavailable)?,
        );

        // 双方先写 hello，内核记录的 socket 对端身份才是实际发送者。
        stream
            .write_all(HELLO)
            .map_err(|_| BrokerError::Untrusted)?;
        let mut hello = [0; 8];
        stream
            .read_exact(&mut hello)
            .map_err(|_| BrokerError::Untrusted)?;
        if &hello != HELLO {
            return Err(BrokerError::Untrusted);
        }
        verify_peer(&stream, child.0.id())?;

        let body = serde_json::to_vec(&input).map_err(|_| BrokerError::InvalidResponse)?;
        if body.len() > MAX_FRAME {
            return Err(BrokerError::InvalidResponse);
        }
        stream
            .write_all(&(body.len() as u32).to_be_bytes())
            .and_then(|_| stream.write_all(&body))
            .map_err(|_| BrokerError::Unavailable)?;
        // 系统授权可能等待用户操作。仅握手/请求有短超时，不反复杀进程重弹密码框。
        stream
            .set_read_timeout(None)
            .map_err(|_| BrokerError::Unavailable)?;
        let response = read_response(&mut stream)?;
        let status = child.0.wait().map_err(|_| BrokerError::Unavailable)?;
        if !status.success() {
            return Err(BrokerError::Unavailable);
        }
        Ok(response)
    }

    fn verify_peer(stream: &UnixStream, expected_pid: u32) -> Result<(), BrokerError> {
        let mut token = [0u32; 8];
        let mut size = std::mem::size_of_val(&token) as libc::socklen_t;
        let result = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_LOCAL,
                libc::LOCAL_PEERTOKEN,
                token.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if result != 0
            || size as usize != std::mem::size_of_val(&token)
            || token[5] != expected_pid
            || token[1] != unsafe { libc::geteuid() }
        {
            return Err(BrokerError::Untrusted);
        }
        let bytes = unsafe {
            std::slice::from_raw_parts(token.as_ptr().cast(), std::mem::size_of_val(&token))
        };
        let data = CFData::from_buffer(bytes);
        let mut attributes = GuestAttributes::new();
        attributes.set_audit_token(data.as_concrete_TypeRef());
        let code = SecCode::copy_guest_with_attribues(None, &attributes, Flags::NONE)
            .map_err(|_| BrokerError::Untrusted)?;
        // 清单锁定 helper 的精确代码身份，含其 hardened runtime/无注入权限配置。
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../keychain-helper/manifest.json"))
                .map_err(|_| BrokerError::Untrusted)?;
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x86_64"
        };
        let hash = manifest["cdhash"][arch]
            .as_str()
            .ok_or(BrokerError::Untrusted)?;
        if hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(BrokerError::Untrusted);
        }
        let requirement = SecRequirement::from_str(&format!(
            "identifier \"com.toskr.keychain-helper\" and certificate leaf = H\"6e960d8b61e1fc9c534e41cb812803d07e85e87b\" and cdhash H\"{hash}\""
        )).map_err(|_| BrokerError::Untrusted)?;
        code.check_validity(Flags::STRICT_VALIDATE, &requirement)
            .map_err(|_| BrokerError::Untrusted)
    }

    fn read_response(stream: &mut impl Read) -> Result<Response, BrokerError> {
        let mut size = [0; 4];
        stream
            .read_exact(&mut size)
            .map_err(|_| BrokerError::InvalidResponse)?;
        let size = u32::from_be_bytes(size) as usize;
        if size == 0 || size > MAX_FRAME {
            return Err(BrokerError::InvalidResponse);
        }
        let mut body = vec![0; size];
        stream
            .read_exact(&mut body)
            .map_err(|_| BrokerError::InvalidResponse)?;
        serde_json::from_slice(&body).map_err(|_| BrokerError::InvalidResponse)
    }

    #[test]
    fn rejects_oversized_truncated_and_unexpected_protocol_responses() {
        for bytes in [u32::MAX.to_be_bytes().to_vec(), vec![0, 0, 0, 12, b'{']] {
            assert!(matches!(
                read_response(&mut bytes.as_slice()),
                Err(BrokerError::InvalidResponse)
            ));
        }
        let json = br#"{"status":0,"secret":"unexpected"}"#;
        let mut bytes = (json.len() as u32).to_be_bytes().to_vec();
        bytes.extend(json);
        assert!(matches!(
            read_response(&mut bytes.as_slice()),
            Err(BrokerError::InvalidResponse)
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denied_access_is_not_a_missing_key() {
        assert!(matches!(
            decode_load(
                Slot::Data,
                Response {
                    status: -25293,
                    value: None
                }
            ),
            Err(BrokerError::Keychain(-25293))
        ));
        assert!(decode_load(
            Slot::Data,
            Response {
                status: NOT_FOUND,
                value: None
            }
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn preserves_records_but_rejects_invalid_data_key_lengths() {
        for size in [0, 31, 33] {
            assert!(decode_load(
                Slot::Data,
                Response {
                    status: 0,
                    value: Some(STANDARD.encode(vec![1; size]))
                }
            )
            .is_err());
        }
        let key = vec![7; 32];
        assert_eq!(
            decode_load(
                Slot::Data,
                Response {
                    status: 0,
                    value: Some(STANDARD.encode(&key))
                }
            )
            .unwrap(),
            Some(key)
        );
        let tombstone = br#"{"key":null,"updated_at_ms":1}"#.to_vec();
        assert_eq!(
            decode_load(
                Slot::Ai,
                Response {
                    status: 0,
                    value: Some(STANDARD.encode(&tombstone))
                }
            )
            .unwrap(),
            Some(tombstone)
        );
    }
}
