//! 自动预览只访问公网；手动授权仅覆盖本次原始 origin。每跳重新解析并固定连接地址。
use std::{net::{IpAddr, SocketAddr}, time::Duration};
use url::Url;

pub(crate) fn parse_url(input: &str) -> Result<Url, String> {
    let mut url = Url::parse(input).map_err(|_| "预览地址无效")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() {
        return Err("预览仅支持无凭据的 HTTP(S) 地址".into());
    }
    url.set_fragment(None);
    Ok(url)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a,b,_,_] = ip.octets();
            !ip.is_private() && !ip.is_loopback() && !ip.is_link_local()
                && !ip.is_broadcast() && !ip.is_documentation() && !ip.is_multicast()
                && a != 0 && a < 240 && !(a == 100 && (64..=127).contains(&b))
                && !(a == 198 && (18..=19).contains(&b)) && !(a == 192 && b == 0)
        }
        IpAddr::V6(ip) => {
            // 仅全球单播；拒绝 mapped/兼容 IPv4、NAT64、6to4 和特殊用途空间。
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000 && s[0] != 0x2002
                && !(s[0] == 0x2001 && s[1] < 0x200)
                && !(s[0] == 0x2001 && s[1] == 0xdb8)
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

fn check_addresses(url: &Url, addresses: &[SocketAddr], private_origin: Option<&str>) -> Result<(), String> {
    if addresses.is_empty() { return Err("预览域名未解析到地址".into()); }
    if private_origin != Some(url.origin().ascii_serialization().as_str())
        && addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err("自动预览已跳过内网或特殊地址；可手动确认获取此链接预览".into());
    }
    Ok(())
}

pub(crate) async fn fetch(input: &str, max_bytes: usize, private_origin: Option<&str>) -> Result<(Vec<u8>, Url), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tokio::time::timeout(Duration::from_secs(8), async {
        let mut url = parse_url(input)?;
        for hop in 0..=4 {
            let host = url.host_str().ok_or("预览地址缺少主机")?.trim_matches(['[', ']']);
            let port = url.port_or_known_default().ok_or("预览端口无效")?;
            let addresses: Vec<_> = tokio::net::lookup_host((host, port)).await
                .map_err(|_| "预览域名解析失败")?.collect();
            check_addresses(&url, &addresses, private_origin)?;
            let client = reqwest::Client::builder().no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .resolve_to_addrs(host, &addresses)
                .timeout(Duration::from_secs(6)).user_agent(crate::linkmeta::UA)
                .build().map_err(|_| "预览连接初始化失败")?;
            let mut response = client.get(url.clone()).send().await.map_err(|_| "预览请求失败")?;
            if response.status().is_redirection() {
                if hop == 4 { return Err("预览重定向次数超限".into()); }
                let location = response.headers().get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok()).ok_or("预览重定向无效")?;
                let next = url.join(location).map_err(|_| "预览重定向地址无效")?;
                url = parse_url(next.as_str())?;
                continue;
            }
            if !response.status().is_success() { return Err("预览服务器返回失败状态".into()); }
            if response.content_length().is_some_and(|n| n > max_bytes as u64) {
                return Err("预览响应过大".into());
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "预览响应读取失败")? {
                if chunk.len() > max_bytes.saturating_sub(body.len()) { return Err("预览响应过大".into()); }
                body.extend_from_slice(&chunk);
            }
            return Ok((body, url));
        }
        Err("预览重定向次数超限".into())
    }).await.map_err(|_| "预览请求超时".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn addresses_and_origin_exception_are_bounded() {
        for value in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2001:db8::1", "2002:7f00:1::"] {
            assert!(!public_ip(value.parse().unwrap()), "{value}");
        }
        assert!(public_ip("1.1.1.1".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
        let url = parse_url("http://intranet.test/a").unwrap();
        let addrs = ["127.0.0.1:80".parse().unwrap()];
        assert!(check_addresses(&url, &addrs, None).is_err());
        assert!(check_addresses(&url, &addrs, Some("http://intranet.test")).is_ok());
        assert!(check_addresses(&url, &addrs, Some("http://other.test")).is_err());
        for value in ["file:///etc/passwd", "ftp://example.com", "https://user:secret@example.com"] {
            assert!(parse_url(value).is_err());
        }
    }
    #[tokio::test]
    async fn local_http_bounds_redirects_status_and_body() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (response, valid) in [
            ("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", true),
            ("HTTP/1.1 500 Error\r\nContent-Length: 2\r\n\r\nok", false),
            ("HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\noversize", false),
            ("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\noversize\r\n0\r\n\r\n", false),
            ("HTTP/1.1 302 Found\r\nLocation: file:///etc/passwd\r\nContent-Length: 0\r\n\r\n", false),
            ("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.2:1/\r\nContent-Length: 0\r\n\r\n", false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let origin = parse_url(&url).unwrap().origin().ascii_serialization();
            // Without explicit approval the socket must remain untouched.
            assert!(fetch(&url, 4, None).await.is_err());
            assert!(tokio::time::timeout(Duration::from_millis(10), listener.accept()).await.is_err());
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                stream.read(&mut request).await.unwrap();
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            assert_eq!(fetch(&url, 4, Some(&origin)).await.is_ok(), valid);
            server.await.unwrap();
        }
    }
}
