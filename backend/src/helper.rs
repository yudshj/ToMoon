use std::{path::Path, process::Command};

use regex::Regex;

use std::fs;

use sysinfo::{ProcessExt, System, SystemExt};

pub fn reset_system_network() -> Result<(), Box<dyn std::error::Error>> {
    //读入程序的 DNS
    let default_config = "[main]\ndns=auto";
    fs::write("/etc/NetworkManager/conf.d/dns.conf", default_config)?;
    // 修改 DNS 为可写
    Command::new("chattr")
        .arg("-i")
        .arg("/etc/resolv.conf")
        .spawn()
        .unwrap()
        .wait()
        .unwrap();
    //fs::copy("./resolv.conf.bk", "/etc/resolv.conf")?;

    // 更新 NetworkManager
    Command::new("nmcli")
        .arg("general")
        .arg("reload")
        .spawn()
        .unwrap()
        .wait()
        .unwrap();
    // match fs::copy("./resolv.conf.bk", "/etc/resolv.conf") {
    //     Ok(_) => (),
    //     Err(e) => {
    //         log::error!("reset_network() error: {}", e);
    //         return vec![];
    //     }
    // }
    log::info!("Successfully reset network");
    Ok(())
}

pub fn get_current_working_dir() -> std::io::Result<std::path::PathBuf> {
    std::env::current_dir()
}

pub fn check_yaml(str: &String) -> bool {
    if let Ok(x) = serde_yaml::from_str::<serde_yaml::Value>(str) {
        if let Some(v) = x.as_mapping() {
            if v.contains_key("rules") {
                return true;
            } else {
                return false;
            }
        } else {
            return false;
        }
    } else {
        return false;
    }
}

pub fn is_clash_running() -> bool {
    //关闭 systemd-resolved
    let mut sys = System::new_all();
    sys.refresh_all();
    for (_, process) in sys.processes() {
        if process.name() == "clash" {
            return true;
        }
    }
    return false;
}

pub fn get_file_path(url: String) -> Option<String> {
    let r = Regex::new(r"^file://").unwrap();
    if let Some(x) = r.find(url.clone().as_str()) {
        let file_path = url[x.end()..url.len()].to_string();
        return Some(file_path);
    };
    return None;
}

/// Split `user:password@` userinfo out of an http(s) URL.
///
/// minreq's URL parser does not understand userinfo: it treats everything
/// before the first `:` as the host, so `https://user:pass@host/path` ends up
/// resolving the host `user`. This returns the URL without userinfo plus the
/// percent-decoded `(user, password)` pair, if any.
pub fn split_url_credentials(url: &str) -> (String, Option<(String, String)>) {
    let scheme_end = match url.find("://") {
        Some(i) => i + 3,
        None => return (url.to_string(), None),
    };
    let rest = &url[scheme_end..];
    let authority_end = rest.find(|c| c == '/' || c == '?' || c == '#').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let at = match authority.rfind('@') {
        Some(i) => i,
        None => return (url.to_string(), None),
    };
    let userinfo = &authority[..at];
    let (user, pass) = match userinfo.find(':') {
        Some(i) => (&userinfo[..i], &userinfo[i + 1..]),
        None => (userinfo, ""),
    };
    let decode = |s: &str| {
        urlencoding::decode(s)
            .map(|v| v.into_owned())
            .unwrap_or_else(|_| s.to_string())
    };
    let stripped = format!("{}{}", &url[..scheme_end], &rest[at + 1..]);
    (stripped, Some((decode(user), decode(pass))))
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Build a GET request, turning URL userinfo into an HTTP Basic auth header.
pub fn http_get(url: &str) -> minreq::Request {
    let (url, credentials) = split_url_credentials(url);
    let request = minreq::get(url);
    match credentials {
        Some((user, pass)) => request.with_header(
            "Authorization",
            format!("Basic {}", base64_encode(format!("{}:{}", user, pass).as_bytes())),
        ),
        None => request,
    }
}

#[cfg(test)]
mod url_credentials_tests {
    use super::*;

    #[test]
    fn strips_userinfo() {
        let (url, cred) = split_url_credentials("https://danny:p%40ss@example.ts.net/clash/a.yaml?x=1");
        assert_eq!(url, "https://example.ts.net/clash/a.yaml?x=1");
        assert_eq!(cred, Some(("danny".to_string(), "p@ss".to_string())));
    }

    #[test]
    fn keeps_plain_urls() {
        for u in ["http://gaia.ts.net/~a/b.yaml", "https://h:8443/p?u=a@b", "https://h"] {
            assert_eq!(split_url_credentials(u), (u.to_string(), None));
        }
    }

    #[test]
    fn user_without_password() {
        let (url, cred) = split_url_credentials("https://token@h/p");
        assert_eq!(url, "https://h/p");
        assert_eq!(cred, Some(("token".to_string(), String::new())));
    }

    #[test]
    fn base64_matches_rfc4648() {
        for (i, o) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("Aladdin:open sesame", "QWxhZGRpbjpvcGVuIHNlc2FtZQ==")] {
            assert_eq!(base64_encode(i.as_bytes()), o);
        }
    }
}
