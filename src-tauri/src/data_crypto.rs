//! 本地数据静态加密信封：Keychain 密钥 + AES-256-GCM。
//!
//! 目标是防「本机其他应用离线读取/篡改落盘文件」：密钥存 macOS 登录钥匙串
//! （ACL 绑定签名，本应用之外读取会触发系统授权），文件内容走 AEAD——
//! 篡改任意一个字节都会认证失败而拒载。不防已解锁本机上的内存取证/调试器
//! （WebView 本就持有全量明文态，故密钥与明文缓冲不做内存零化）。
//!
//! ⚠️ 信封格式发布后冻结：`TSK1(4B) | version(1B) | nonce(12B) | 密文+GCM tag(16B)`。
//! 兼容规则只增不改——升级格式必须递增 version 并保留旧 version 的解码分支；
//! 明文直通（迁移前旧文件）永久保留，因为 RENAME_SWAP 提交会回读被换下的旧文件。
//! AAD 是用途标签，防止把 A 文件的密文调包到 B 文件仍能解开。

use std::fs::File;
use std::io::Read;
#[cfg(not(test))]
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

#[cfg(all(target_os = "macos", not(test)))]
use security_framework::passwords::{get_generic_password, set_generic_password};
#[cfg(all(target_os = "macos", not(test)))]
use security_framework_sys::base::errSecItemNotFound;

#[cfg(all(target_os = "macos", not(test)))]
const KEYCHAIN_SERVICE: &str = "com.toskr.app.data";
#[cfg(all(target_os = "macos", not(test)))]
const KEYCHAIN_ACCOUNT: &str = "data-encryption-key-v1";

const MAGIC: &[u8; 4] = b"TSK1";
const VERSION: u8 = 1;
const NONCE_LEN: usize = 12;
const HEADER_LEN: usize = 4 + 1 + NONCE_LEN;
const TAG_LEN: usize = 16;
/// 信封相对明文的固定膨胀（写入方校验大小上限时按密文长度算）。
pub const ENVELOPE_OVERHEAD: usize = HEADER_LEN + TAG_LEN;

#[cfg(all(target_os = "macos", not(test)))]
static KEYCHAIN_LOCK: Mutex<()> = Mutex::new(());
/// 进程内密钥缓存：仅在钥匙串读取成功后写入，弹窗被拒后可整链重试。
#[cfg(not(test))]
static KEY_CACHE: Mutex<Option<[u8; 32]>> = Mutex::new(None);

/// AAD 用途标签：跨用途调包（media 密文冒充 data）直接认证失败。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Data,
    Media,
    ImWatch,
    Recovery,
}

impl Purpose {
    fn aad(self) -> &'static [u8] {
        match self {
            Purpose::Data => b"data",
            Purpose::Media => b"media",
            Purpose::ImWatch => b"imwatch",
            Purpose::Recovery => b"recovery",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptoError {
    /// 钥匙串访问失败（弹窗被拒 / 钥匙串锁定）。
    KeychainDenied,
    /// 数据已加密但本机钥匙串没有对应密钥（换机 / 钥匙串重置）。
    KeyMissing,
    /// AEAD 认证失败：内容被外部修改、损坏，或由其他机器的密钥封装。
    AuthFailed,
    /// 有 TSK1 魔数但信封结构不完整 / 版本不认识。
    Malformed,
    Internal(String),
}

impl CryptoError {
    pub fn message(&self) -> String {
        match self {
            CryptoError::KeychainDenied => {
                "无法访问 macOS 钥匙串以解锁本机数据；解锁钥匙串后重试".into()
            }
            CryptoError::KeyMissing => {
                "本机钥匙串中没有解开这份数据的密钥；请用「导入完整备份」恢复".into()
            }
            CryptoError::AuthFailed => {
                "数据校验失败（可能被外部修改、损坏，或来自其他机器）".into()
            }
            CryptoError::Malformed => "加密信封格式无效".into(),
            CryptoError::Internal(detail) => format!("加密内部错误：{detail}"),
        }
    }

    /// 密钥层不可用（区别于内容层损坏/篡改）。
    pub fn key_unavailable(&self) -> bool {
        matches!(self, CryptoError::KeychainDenied | CryptoError::KeyMissing)
    }
}

/// 是否已是加密信封。只看魔数前缀：截断的信封应报 Malformed，而不是被当明文直通。
/// 明文旧格式（JSON 以 `{`/空白开头、PNG 以 `\x89PNG` 开头、账本行以 `{` 开头）
/// 与 `TSK1` 前缀天然不相交。
pub fn looks_sealed(bytes: &[u8]) -> bool {
    bytes.starts_with(MAGIC)
}

/// 用当前密钥封装明文。
pub fn seal(purpose: Purpose, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    seal_with_key(&key()?, purpose, plaintext)
}

/// 打开信封（输入必须是信封；明文请走 `open_or_passthrough`）。
pub fn open(purpose: Purpose, bytes: &[u8]) -> Result<Vec<u8>, CryptoError> {
    open_with_key(&key()?, purpose, bytes)
}

/// 旧明文直通、信封解密：返回 (明文, 输入是否为信封)。
pub fn open_or_passthrough(
    purpose: Purpose,
    bytes: Vec<u8>,
) -> Result<(Vec<u8>, bool), CryptoError> {
    if looks_sealed(&bytes) {
        Ok((open(purpose, &bytes)?, true))
    } else {
        Ok((bytes, false))
    }
}

/// 校验密钥可用（不创建）：KeychainDenied 与 KeyMissing 由调用方区分提示。
pub fn require_key() -> Result<(), CryptoError> {
    key().map(|_| ())
}

/// 读取或首次创建密钥。只允许在「数据尚未加密」的前提下调用——
/// 数据已加密而密钥缺失时绝不能走到这里重新生成（会永久锁死存量密文）。
pub fn ensure_key() -> Result<(), CryptoError> {
    #[cfg(test)]
    {
        test_key::ensure();
        Ok(())
    }
    #[cfg(not(test))]
    {
        if cached_key().is_some() {
            return Ok(());
        }
        match keychain_load()? {
            Some(key) => {
                set_cached_key(key);
                Ok(())
            }
            None => {
                let key: [u8; 32] = random_bytes()?;
                keychain_store(&key)?;
                set_cached_key(key);
                Ok(())
            }
        }
    }
}

fn key() -> Result<[u8; 32], CryptoError> {
    #[cfg(test)]
    {
        // 测试环境绝不触碰真实钥匙串：密钥由各测试线程显式安装。
        test_key::get().ok_or(CryptoError::KeyMissing)
    }
    #[cfg(not(test))]
    {
        if let Some(key) = cached_key() {
            return Ok(key);
        }
        match keychain_load()? {
            Some(key) => {
                set_cached_key(key);
                Ok(key)
            }
            None => Err(CryptoError::KeyMissing),
        }
    }
}

#[cfg(not(test))]
fn cached_key() -> Option<[u8; 32]> {
    match KEY_CACHE.lock() {
        Ok(guard) => *guard,
        Err(poison) => *poison.into_inner(),
    }
}

#[cfg(not(test))]
fn set_cached_key(key: [u8; 32]) {
    match KEY_CACHE.lock() {
        Ok(mut guard) => *guard = Some(key),
        Err(poison) => *poison.into_inner() = Some(key),
    }
}

fn seal_with_key(
    key: &[u8; 32],
    purpose: Purpose,
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| CryptoError::Internal("密钥长度异常".into()))?;
    let nonce_bytes: [u8; NONCE_LEN] = random_bytes()?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload { msg: plaintext, aad: purpose.aad() },
        )
        .map_err(|_| CryptoError::Internal("加密失败".into()))?;
    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn open_with_key(key: &[u8; 32], purpose: Purpose, bytes: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if !looks_sealed(bytes) || bytes.len() < HEADER_LEN + TAG_LEN {
        return Err(CryptoError::Malformed);
    }
    if bytes[4] != VERSION {
        // 只认识 version 1；将来升级格式时在这里加旧版本分支。
        return Err(CryptoError::Malformed);
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| CryptoError::Internal("密钥长度异常".into()))?;
    let nonce = Nonce::from_slice(&bytes[5..HEADER_LEN]);
    cipher
        .decrypt(nonce, Payload { msg: &bytes[HEADER_LEN..], aad: purpose.aad() })
        .map_err(|_| CryptoError::AuthFailed)
}

/// 随机字节：与 message_watch 同款 /dev/urandom 直读，避免引入 rand 依赖。
fn random_bytes<const N: usize>() -> Result<[u8; N], CryptoError> {
    let mut bytes = [0u8; N];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|error| CryptoError::Internal(format!("随机数不可用：{error}")))?;
    Ok(bytes)
}

#[cfg(all(target_os = "macos", not(test)))]
fn keychain_load() -> Result<Option<[u8; 32]>, CryptoError> {
    let _guard = match KEYCHAIN_LOCK.lock() {
        Ok(guard) => guard,
        Err(poison) => poison.into_inner(),
    };
    match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(bytes) => {
            let key: [u8; 32] = bytes
                .as_slice()
                .try_into()
                .map_err(|_| CryptoError::Internal("钥匙串中的数据密钥长度异常".into()))?;
            Ok(Some(key))
        }
        Err(error) if error.code() == errSecItemNotFound => Ok(None),
        Err(_) => Err(CryptoError::KeychainDenied),
    }
}

#[cfg(all(target_os = "macos", not(test)))]
fn keychain_store(key: &[u8; 32]) -> Result<(), CryptoError> {
    let _guard = match KEYCHAIN_LOCK.lock() {
        Ok(guard) => guard,
        Err(poison) => poison.into_inner(),
    };
    set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, key)
        .map_err(|_| CryptoError::KeychainDenied)
}

#[cfg(all(not(target_os = "macos"), not(test)))]
fn keychain_load() -> Result<Option<[u8; 32]>, CryptoError> {
    Err(CryptoError::Internal("数据密钥仅支持 macOS Keychain".into()))
}

#[cfg(all(not(target_os = "macos"), not(test)))]
fn keychain_store(_key: &[u8; 32]) -> Result<(), CryptoError> {
    Err(CryptoError::Internal("数据密钥仅支持 macOS Keychain".into()))
}

/// 测试密钥用 thread_local：cargo test 并行跑，各测试线程互不串扰，
/// 且任何测试路径都不会触碰真实钥匙串。三态语义——未设置时首次取用自动装
/// 固定密钥（既有测试零改动即可走加密路径），显式 `clear` 才模拟「数据已
/// 加密但本机无钥」。
#[cfg(test)]
pub(crate) mod test_key {
    use std::cell::Cell;

    const FIXED: [u8; 32] = [42u8; 32];

    #[derive(Clone, Copy)]
    enum State {
        Unset,
        Cleared,
        Key([u8; 32]),
    }

    thread_local! {
        static STATE: Cell<State> = const { Cell::new(State::Unset) };
    }

    /// 在当前测试线程安装固定密钥（幂等）。
    pub(crate) fn install() {
        STATE.with(|cell| cell.set(State::Key(FIXED)));
    }

    /// 移除当前测试线程的密钥（模拟「数据已加密但无钥」场景）。
    pub(crate) fn clear() {
        STATE.with(|cell| cell.set(State::Cleared));
    }

    /// 对应生产 `ensure_key`：无钥则创建。
    pub(crate) fn ensure() {
        install();
    }

    pub(crate) fn get() -> Option<[u8; 32]> {
        STATE.with(|cell| match cell.get() {
            State::Unset => {
                cell.set(State::Key(FIXED));
                Some(FIXED)
            }
            State::Cleared => None,
            State::Key(key) => Some(key),
        })
    }
}

#[cfg(test)]
pub(crate) fn install_test_key() {
    test_key::install();
}

#[cfg(test)]
pub(crate) fn clear_test_key() {
    test_key::clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trips_and_never_repeats_a_nonce() {
        install_test_key();
        let plain = "划词捕获的敏感内容".as_bytes();
        let a = seal(Purpose::Data, plain).unwrap();
        let b = seal(Purpose::Data, plain).unwrap();
        assert!(looks_sealed(&a));
        assert_ne!(a, b, "随机 nonce 下同明文两次封装不应产生相同密文");
        assert_ne!(a[5..17], b[5..17], "nonce 不应重复");
        assert_eq!(open(Purpose::Data, &a).unwrap(), plain);
        assert_eq!(open(Purpose::Data, &b).unwrap(), plain);
        assert_eq!(a.len(), plain.len() + ENVELOPE_OVERHEAD);
    }

    #[test]
    fn tampering_any_byte_fails_authentication() {
        install_test_key();
        let sealed = seal(Purpose::Data, b"integrity matters").unwrap();
        // 头部魔数被改则不再是信封 → Malformed；其余任一字节翻转 → AuthFailed。
        for index in [4usize, 6, HEADER_LEN, sealed.len() - 1] {
            let mut broken = sealed.clone();
            broken[index] ^= 0x01;
            let error = open(Purpose::Data, &broken).unwrap_err();
            assert!(
                matches!(error, CryptoError::AuthFailed | CryptoError::Malformed),
                "index {index} 应拒载，实得 {error:?}"
            );
        }
        // 截掉尾部但仍够最小信封长 → 认证失败；短于最小信封长 → 格式无效。
        let mut truncated = sealed.clone();
        truncated.truncate(HEADER_LEN + TAG_LEN + 2);
        assert_eq!(open(Purpose::Data, &truncated).unwrap_err(), CryptoError::AuthFailed);
        assert_eq!(open(Purpose::Data, &sealed[..10]).unwrap_err(), CryptoError::Malformed);
    }

    #[test]
    fn purpose_tag_prevents_cross_file_ciphertext_swapping() {
        install_test_key();
        let sealed = seal(Purpose::Media, b"\x89PNG fake pixels").unwrap();
        assert_eq!(open(Purpose::Data, &sealed).unwrap_err(), CryptoError::AuthFailed);
        assert!(open(Purpose::Media, &sealed).is_ok());
    }

    #[test]
    fn legacy_plaintext_passes_through_and_sealed_bytes_are_detected() {
        install_test_key();
        let json = br#"{"toskr":"{}"}"#.to_vec();
        let (out, was_sealed) = open_or_passthrough(Purpose::Data, json.clone()).unwrap();
        assert_eq!(out, json);
        assert!(!was_sealed);

        let png = b"\x89PNG\r\n\x1a\n....".to_vec();
        let (out, was_sealed) = open_or_passthrough(Purpose::Media, png.clone()).unwrap();
        assert_eq!(out, png);
        assert!(!was_sealed);

        let sealed = seal(Purpose::Data, b"cipher").unwrap();
        let (out, was_sealed) = open_or_passthrough(Purpose::Data, sealed).unwrap();
        assert_eq!(out, b"cipher");
        assert!(was_sealed);
    }

    #[test]
    fn wrong_key_is_classified_as_auth_failure_not_corruption() {
        let key_a = [1u8; 32];
        let key_b = [2u8; 32];
        let sealed = seal_with_key(&key_a, Purpose::Data, b"payload").unwrap();
        assert_eq!(
            open_with_key(&key_b, Purpose::Data, &sealed).unwrap_err(),
            CryptoError::AuthFailed
        );
        assert_eq!(open_with_key(&key_a, Purpose::Data, &sealed).unwrap(), b"payload");
    }

    #[test]
    fn missing_key_is_reported_as_key_missing() {
        clear_test_key();
        assert_eq!(seal(Purpose::Data, b"x").unwrap_err(), CryptoError::KeyMissing);
        assert_eq!(require_key().unwrap_err(), CryptoError::KeyMissing);
        install_test_key();
        assert!(require_key().is_ok());
    }
}
