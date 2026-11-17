use std::fmt::Display;
use std::path::{Path, PathBuf};
use std::os::unix::fs::MetadataExt;
use std::process::Command;
use std::sync::{Arc, RwLock};

use std::time::Duration;
use std::{error, fs, thread};

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

use super::helper;
use super::settings::{Settings, State};

use serde_json::json;

pub struct ControlRuntime {
    settings: Arc<RwLock<Settings>>,
    state: Arc<RwLock<State>>,
    clash_state: Arc<RwLock<Clash>>,
    downlaod_status: Arc<RwLock<DownloadStatus>>,
    update_status: Arc<RwLock<DownloadStatus>>,
    running_status: Arc<RwLock<RunningStatus>>,
}

#[derive(Debug)]
pub enum RunningStatus {
    Loading,
    Failed,
    Success,
    None,
}

#[derive(Debug)]
pub enum DownloadStatus {
    Downloading,
    Failed,
    Success,
    Error,
    None,
}

#[derive(Debug, Serialize, Deserialize, Copy, Clone)]
pub enum EnhancedMode {
    RedirHost,
    FakeIp,
}

impl std::fmt::Display for DownloadStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{:?}", self)
        // or, alternatively:
        // fmt::Debug::fmt(self, f)
    }
}

impl std::fmt::Display for RunningStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{:?}", self)
        // or, alternatively:
        // fmt::Debug::fmt(self, f)
    }
}

// pub struct DownloadStatus {

// }

impl ControlRuntime {
    pub fn new() -> Self {
        let new_state = State::new();
        let settings_p = settings_path(&new_state.home);
        //TODO: Clash 路径
        let clash = Clash::default();
        let download_status = DownloadStatus::None;
        let update_status = DownloadStatus::None;
        let running_status = RunningStatus::None;
        Self {
            settings: Arc::new(RwLock::new(
                super::settings::Settings::open(settings_p)
                    .unwrap_or_default()
                    .into(),
            )),
            state: Arc::new(RwLock::new(new_state)),
            clash_state: Arc::new(RwLock::new(clash)),
            downlaod_status: Arc::new(RwLock::new(download_status)),
            update_status: Arc::new(RwLock::new(update_status)),
            running_status: Arc::new(RwLock::new(running_status)),
        }
    }

    pub(crate) fn settings_clone(&self) -> Arc<RwLock<Settings>> {
        self.settings.clone()
    }

    pub(crate) fn state_clone(&self) -> Arc<RwLock<State>> {
        self.state.clone()
    }

    pub fn clash_state_clone(&self) -> Arc<RwLock<Clash>> {
        self.clash_state.clone()
    }

    pub fn downlaod_status_clone(&self) -> Arc<RwLock<DownloadStatus>> {
        self.downlaod_status.clone()
    }

    pub fn update_status_clone(&self) -> Arc<RwLock<DownloadStatus>> {
        self.update_status.clone()
    }

    pub fn running_status_clone(&self) -> Arc<RwLock<RunningStatus>> {
        self.running_status.clone()
    }

    pub fn run(&self) -> thread::JoinHandle<()> {
        let runtime_settings = self.settings_clone();
        let runtime_state = self.state_clone();

        if let Err(e) = refresh_installed_service() {
            log::error!("refresh {} failed: {}", CORE_SERVICE, e);
        }

        //health check
        //当程序上次异常退出时的处理
        if let Ok(mut v) = runtime_settings.write() {
            if !helper::is_clash_running() && v.enable {
                v.enable = false;
                drop(v);
                //刷新网卡
                match helper::reset_system_network() {
                    Ok(_) => {}
                    Err(e) => {
                        log::error!("runtime failed to acquire settings write lock: {}", e);
                    }
                }
            }
        }

        //save config
        thread::spawn(move || {
            let sleep_duration = Duration::from_millis(1000);
            loop {
                //let start_time = Instant::now();
                {
                    // save to file
                    let state = match runtime_state.read() {
                        Ok(x) => x,
                        Err(e) => {
                            log::error!("runtime failed to acquire state read lock: {}", e);
                            continue;
                        }
                    };
                    if state.dirty {
                        // save settings to file
                        let settings = match runtime_settings.read() {
                            Ok(x) => x,
                            Err(e) => {
                                log::error!("runtime failed to acquire settings read lock: {}", e);
                                continue;
                            }
                        };
                        let settings_json: Settings = settings.clone().into();
                        if let Err(e) = settings_json.save(settings_path(&state.home)) {
                            log::error!(
                                "SettingsJson.save({}) error: {}",
                                settings_path(&state.home).display(),
                                e
                            );
                        }
                        //Self::on_set_enable(&settings, &state);
                        drop(state);
                        let mut state = match runtime_state.write() {
                            Ok(x) => x,
                            Err(e) => {
                                log::error!("runtime failed to acquire state write lock: {}", e);
                                continue;
                            }
                        };
                        state.dirty = false;
                    }
                }
                thread::sleep(sleep_duration);
            }
        })
    }
}

fn settings_path<P: AsRef<std::path::Path>>(home: P) -> std::path::PathBuf {
    home.as_ref().join(".config/tomoon/tomoon.json")
}

fn get_current_working_dir() -> std::io::Result<std::path::PathBuf> {
    helper::get_current_working_dir()
}

fn get_decky_data_dir() -> std::io::Result<std::path::PathBuf> {
    let data_dir = get_current_working_dir().unwrap().join("../../data/tomoon");
    // Resolve `..`: systemd rejects non-normalized paths in unit files.
    Ok(fs::canonicalize(&data_dir).unwrap_or(data_dir))
}

/// mihomo runs as an always-on system service owned by the Decky user.
///
/// Its lifecycle is tied to the "install / uninstall system service" actions
/// in the plugin only: once installed it is enabled at boot and keeps serving
/// the proxy ports (e.g. for browser proxy extensions) and the controller.
/// The "enable Clash" switch merely turns the TUN transparent proxy on/off in
/// the running core. The core binary is copied into the data dir so plugin
/// updates (which delete the plugin dir) do not affect the service.
pub const CORE_SERVICE: &str = "tomoon-mihomo.service";
const CORE_UNIT_PATH: &str = "/etc/systemd/system/tomoon-mihomo.service";

fn systemctl(args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("systemctl").args(args).output()
}

pub fn core_service_installed() -> bool {
    Path::new(CORE_UNIT_PATH).is_file()
}

pub fn core_service_active() -> bool {
    systemctl(&["is-active", "--quiet", CORE_SERVICE])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn systemctl_ok(args: &[&str]) -> Result<(), Box<dyn error::Error>> {
    let out = systemctl(args)?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "systemctl {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )
        .into())
    }
}

fn write_core_unit(
    binary: &Path,
    data_dir: &Path,
    run_config: &Path,
    uid: u32,
    gid: u32,
) -> Result<bool, Box<dyn error::Error>> {
    let unit = render_core_unit(binary, data_dir, run_config, uid, gid);
    if fs::read_to_string(CORE_UNIT_PATH).ok().as_deref() == Some(unit.as_str()) {
        return Ok(false);
    }
    fs::write(CORE_UNIT_PATH, unit)?;
    systemctl_ok(&["daemon-reload"])?;
    Ok(true)
}

/// On backend start: if the service is installed but its unit differs from
/// the current template (older plugin version), rewrite it, make sure it is
/// enabled at boot and restart it if it was running.
pub fn refresh_installed_service() -> Result<(), Box<dyn error::Error>> {
    if !core_service_installed() {
        return Ok(());
    }
    let (uid, gid) = decky_user_ids();
    let data_dir = fs::canonicalize(get_decky_data_dir()?)?;
    let binary = data_dir.join("mihomo");
    if !binary.is_file() {
        let bundled = get_current_working_dir()?.join("bin/core/clash");
        fs::copy(&bundled, &binary)?;
        fs::set_permissions(&binary, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
        let _ = Command::new("chown")
            .arg(format!("{}:{}", uid, gid))
            .arg(&binary)
            .status();
    }
    let was_active = core_service_active();
    if write_core_unit(&binary, &data_dir, &data_dir.join("running_config.yaml"), uid, gid)? {
        log::info!("Updated {} to the current template", CORE_UNIT_PATH);
        systemctl_ok(&["enable", CORE_SERVICE])?;
        if was_active {
            restart_core_service()?;
        }
    }
    Ok(())
}

/// (Re)start the service and make sure it did not die right away
/// (Type=simple returns as soon as the process is forked).
fn restart_core_service() -> Result<(), Box<dyn error::Error>> {
    systemctl_ok(&["restart", CORE_SERVICE])?;
    thread::sleep(Duration::from_millis(800));
    if !core_service_active() {
        return Err(format!(
            "{} exited right after start, see journalctl -u {}",
            CORE_SERVICE, CORE_SERVICE
        )
        .into());
    }
    Ok(())
}

/// uid/gid owning the Decky data directory (the Decky user, normally deck).
fn decky_user_ids() -> (u32, u32) {
    get_decky_data_dir()
        .ok()
        .and_then(|d| fs::metadata(d.join("..")).ok())
        .map(|m| (m.uid(), m.gid()))
        .filter(|(uid, _)| *uid != 0)
        .unwrap_or((1000, 1000))
}

fn render_core_unit(binary: &Path, data_dir: &Path, config: &Path, uid: u32, gid: u32) -> String {
    format!(
        "# Installed by the ToMoon Decky plugin (Overview > System service).
[Unit]
Description=ToMoon mihomo core
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={uid}
Group={gid}
WorkingDirectory={data}
ExecStart=\"{bin}\" -d \"{data}\" -f \"{config}\"
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW CAP_NET_BIND_SERVICE CAP_SYS_PTRACE CAP_DAC_READ_SEARCH
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW CAP_NET_BIND_SERVICE CAP_SYS_PTRACE CAP_DAC_READ_SEARCH
NoNewPrivileges=yes
Restart=on-failure
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
",
        uid = uid,
        gid = gid,
        bin = binary.display(),
        data = data_dir.display(),
        config = config.display(),
    )
}

pub struct Clash {
    pub path: std::path::PathBuf,
    pub config: std::path::PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ClashErrorKind {
    ConfigFormatError,
    ConfigNotFound,
    NetworkError,
    InnerError,
    Default,
    CpDbError,
}

#[derive(Debug)]
pub struct ClashError {
    pub Message: String,
    pub ErrorKind: ClashErrorKind,
}

impl error::Error for ClashError {}

impl Display for ClashError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Error Kind: {:?}, Error Message: {})",
            self.ErrorKind, self.Message
        )
    }
}

impl ClashError {
    pub fn new() -> Self {
        Self {
            Message: "".to_string(),
            ErrorKind: ClashErrorKind::Default,
        }
    }
}

impl Default for Clash {
    fn default() -> Self {
        Self {
            path: get_current_working_dir().unwrap().join("bin/core/clash"),
            config: get_current_working_dir()
                .unwrap()
                .join("bin/core/config.yaml"),
        }
    }
}

impl Clash {
    /// Copy bundled geo databases if missing and regenerate the running
    /// config from the current subscription and settings (TUN = `enable`).
    pub fn prepare_config(&mut self, settings: &Settings) -> Result<(), ClashError> {
        // decky 插件数据目录
        let decky_data_dir = get_decky_data_dir().unwrap();
        let new_country_db_path = get_current_working_dir()
            .unwrap()
            .join("bin/core/country.mmdb");
        let new_asn_db_path = get_current_working_dir().unwrap().join("bin/core/asn.mmdb");
        let new_geosite_path = get_current_working_dir()
            .unwrap()
            .join("bin/core/geosite.dat");
        let country_db_path = decky_data_dir.join("country.mmdb");
        let asn_db_path = decky_data_dir.join("asn.mmdb");
        let geosite_path = decky_data_dir.join("geosite.dat");

        // 检查 decky_data_dir 是否存在，不存在则创建
        if !decky_data_dir.exists() {
            fs::create_dir_all(&decky_data_dir).unwrap();
        }

        // 检查数据库文件是否存在，不存在则复制
        if !PathBuf::from(country_db_path.clone()).is_file() {
            match fs::copy(new_country_db_path.clone(), country_db_path.clone()) {
                Ok(_) => {
                    log::info!("Copy country.mmdb to decky data dir")
                }
                Err(e) => {
                    return Err(ClashError {
                        Message: e.to_string(),
                        ErrorKind: ClashErrorKind::CpDbError,
                    });
                }
            }
        }

        if !PathBuf::from(asn_db_path.clone()).is_file() {
            match fs::copy(new_asn_db_path.clone(), asn_db_path.clone()) {
                Ok(_) => {
                    log::info!("Copy asn.mmdb to decky data dir")
                }
                Err(e) => {
                    return Err(ClashError {
                        Message: e.to_string(),
                        ErrorKind: ClashErrorKind::CpDbError,
                    });
                }
            }
        }

        if !PathBuf::from(geosite_path.clone()).is_file() {
            match fs::copy(new_geosite_path.clone(), geosite_path.clone()) {
                Ok(_) => {
                    log::info!("Copy geosite.dat to decky data dir")
                }
                Err(e) => {
                    return Err(ClashError {
                        Message: e.to_string(),
                        ErrorKind: ClashErrorKind::CpDbError,
                    });
                }
            }
        }

        if settings.current_sub.is_empty() {
            return Err(ClashError {
                Message: "no subscription selected".to_string(),
                ErrorKind: ClashErrorKind::ConfigNotFound,
            });
        }
        self.update_config_path(&settings.current_sub);
        // 修改配置文件为推荐配置
        self.change_config(
            settings.skip_proxy,
            settings.override_dns,
            settings.allow_remote_access,
            settings.allow_lan,
            settings.enable,
            settings.enhanced_mode,
            settings.dashboard.clone(),
        )
        .map_err(|e| ClashError {
            Message: e.to_string(),
            ErrorKind: ClashErrorKind::ConfigFormatError,
        })
    }

    /// Regenerate the running config and apply it to the service: hot
    /// reload when running, start it when installed but stopped.
    pub fn apply(&mut self, settings: &Settings) -> Result<(), ClashError> {
        self.prepare_config(settings)?;
        if core_service_active() {
            self.reload_config()
        } else if core_service_installed() {
            restart_core_service().map_err(|e| ClashError {
                Message: e.to_string(),
                ErrorKind: ClashErrorKind::InnerError,
            })
        } else {
            Ok(())
        }
    }

    /// Install (or reinstall) the always-on service and start it.
    pub fn install_service(&mut self, settings: &Settings) -> Result<(), Box<dyn error::Error>> {
        self.prepare_config(settings)?;

        let (uid, gid) = decky_user_ids();
        let data_dir = fs::canonicalize(get_decky_data_dir()?)?;
        let run_config = data_dir.join("running_config.yaml");

        // Private copy of the core: the plugin dir is replaced on updates.
        // Copy + rename so a running binary is never overwritten in place.
        let binary = data_dir.join("mihomo");
        let staging = data_dir.join(".mihomo.new");
        fs::copy(&self.path, &staging)?;
        fs::set_permissions(&staging, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
        fs::rename(&staging, &binary)?;

        // Files written by the root backend must stay usable by the core
        // (cache.db, geo updates, provider downloads).
        let chown = Command::new("chown")
            .arg("-R")
            .arg(format!("{}:{}", uid, gid))
            .arg(&data_dir)
            .status()?;
        if !chown.success() {
            log::warn!("chown {} failed: {}", data_dir.display(), chown);
        }

        write_core_unit(&binary, &data_dir, &run_config, uid, gid)?;

        // A core left over from the old child-process launcher would hold
        // the ports; it is not managed by the service, so stop it.
        if !core_service_active() {
            let _ = Command::new("pkill").args(["-x", "clash"]).status();
        }

        systemctl_ok(&["enable", CORE_SERVICE])?;
        restart_core_service()?;
        log::info!("Installed and started {}", CORE_SERVICE);
        Ok(())
    }

    /// Stop, disable and remove the service; restore system networking.
    pub fn uninstall_service(&mut self) -> Result<(), Box<dyn error::Error>> {
        if core_service_installed() {
            if let Err(e) = systemctl_ok(&["disable", "--now", CORE_SERVICE]) {
                log::error!("{}", e);
            }
            fs::remove_file(CORE_UNIT_PATH)?;
            systemctl_ok(&["daemon-reload"])?;
        }
        if let Ok(dir) = get_decky_data_dir() {
            let _ = fs::remove_file(dir.join("mihomo"));
        }
        //直接重置网络
        helper::reset_system_network()?;
        log::info!("Removed {}", CORE_SERVICE);
        Ok(())
    }

    pub fn update_config_path(&mut self, path: &String) {
        self.config = std::path::PathBuf::from((*path).clone());
    }

    pub fn get_running_config(&self) -> std::io::Result<std::path::PathBuf> {
        let decky_data_dir = get_decky_data_dir().unwrap();
        let run_config = decky_data_dir.join("running_config.yaml");
        Ok(run_config)
    }

    /// Add the controller secret of the running config, if any.
    fn authorized(&self, request: minreq::Request) -> minreq::Request {
        match self.get_running_secret() {
            Ok(secret) if !secret.is_empty() => {
                request.with_header("Authorization", format!("Bearer {}", secret))
            }
            _ => request,
        }
    }

    pub fn reload_config(&self) -> Result<(), ClashError> {
        let run_config = self.get_running_config().unwrap();
        log::info!("Reloading Clash config, config: {}", run_config.display());

        // force=true also rebinds listeners (ports, allow-lan); TUN is
        // re-applied regardless.
        let url = "http://127.0.0.1:9090/configs?force=true";
        let body = json!({
            "path": run_config,
            "payload": ""
        });

        let body_str = serde_json::to_string(&body).unwrap();

        let res = match self
            .authorized(minreq::put(url))
            .with_header("Content-Type", "application/json")
            .with_body(body_str)
            .send()
        {
            Ok(x) => x,
            Err(e) => {
                log::error!("Failed to restart Clash core: {}", e);
                return Err(ClashError {
                    Message: e.to_string(),
                    ErrorKind: ClashErrorKind::InnerError,
                });
            }
        };

        if res.status_code == 200 || res.status_code == 204 {
            log::info!("Clash config reloaded successfully");
        } else {
            let message = format!(
                "Failed to reload Clash config, status_code {}: {}",
                res.status_code,
                res.as_str().unwrap_or("")
            );
            log::error!("{}", message);
            return Err(ClashError {
                Message: message,
                ErrorKind: ClashErrorKind::InnerError,
            });
        }

        Ok(())
    }

    pub async fn restart_core(&self) -> Result<(), ClashError> {
        log::info!("Restarting Clash core...");

        let url = "http://127.0.0.1:9090/restart";
        let body = json!({
            "payload": ""
        });
        let body_str = serde_json::to_string(&body).unwrap();

        let res = match self
            .authorized(minreq::post(url))
            .with_header("Content-Type", "application/json")
            .with_body(body_str)
            .send()
        {
            Ok(x) => x,
            Err(e) => {
                log::error!("Failed to restart Clash core: {}", e);
                return Err(ClashError {
                    Message: e.to_string(),
                    ErrorKind: ClashErrorKind::InnerError,
                });
            }
        };

        if res.status_code == 200 {
            log::info!("Clash restart successfully");
        } else {
            let data = res.as_str().unwrap();
            log::error!("Failed to restart Clash core: {}", data);
        }

        Ok(())
    }

    pub fn change_config(
        &self,
        skip_proxy: bool,
        override_dns: bool,
        allow_remote_access: bool,
        allow_lan: bool,
        tun: bool,
        enhanced_mode: EnhancedMode,
        dashboard: String,
    ) -> Result<(), Box<dyn error::Error>> {
        let path = self.config.clone();
        log::info!("change_config path: {:?}", path);

        let config = fs::read_to_string(path)?;
        let mut yaml: serde_yaml::Value = serde_yaml::from_str(config.as_str())?;
        let yaml = yaml.as_mapping_mut().unwrap();

        log::info!("Changing Clash config...");

        let external_ip = if allow_remote_access {
            "0.0.0.0"
        } else {
            "127.0.0.1"
        };

        // 局域网连接：允许其他设备使用代理端口
        yaml.insert(Value::String("allow-lan".into()), Value::Bool(allow_lan));
        if allow_lan {
            yaml.insert(
                Value::String("bind-address".into()),
                Value::String("*".into()),
            );
        }

        //修改 WebUI
        match yaml.get_mut("external-controller") {
            Some(x) => {
                *x = Value::String(String::from(format!("{}:9090", external_ip)));
            }
            None => {
                yaml.insert(
                    Value::String(String::from("external-controller")),
                    Value::String(String::from(format!("{}:9090", external_ip))),
                );
            }
        }

        //修改 test.steampowered.com
        //这个域名用于 Steam Deck 网络连接验证，可以直连
        if let Some(x) = yaml.get_mut("rules") {
            let rules = x.as_sequence_mut().unwrap();
            rules.insert(
                0,
                Value::String(String::from("DOMAIN,test.steampowered.com,DIRECT")),
            );

            if skip_proxy {
                rules.insert(
                    0,
                    Value::String(String::from("DOMAIN-SUFFIX,cm.steampowered.com,DIRECT")),
                );
                rules.insert(
                    0,
                    Value::String(String::from("DOMAIN-SUFFIX,steamserver.net,DIRECT")),
                );
            }
        }

        let webui_dir = get_current_working_dir()?.join("bin/core/web");

        match yaml.get_mut("external-ui") {
            Some(x) => {
                //TODO: 修改 Web UI 的路径
                *x = Value::String(String::from(webui_dir.to_str().unwrap()));
            }
            None => {
                yaml.insert(
                    Value::String(String::from("external-ui")),
                    Value::String(String::from(webui_dir.to_str().unwrap())),
                );
            }
        }

        //  修改 dashboard 名称
        match yaml.get_mut("external-ui-name") {
            Some(x) => {
                *x = Value::String(String::from(dashboard));
            }
            None => {
                yaml.insert(
                    Value::String(String::from("external-ui-name")),
                    Value::String(String::from(dashboard)),
                );
            }
        }

        //修改 TUN 和 DNS 配置

        let tun_config = &format!(
            "
        enable: {}
        stack: system
        auto-route: true
        auto-detect-interface: true
        dns-hijack:
            - any:53
        ",
            tun
        );

        //部分配置来自 https://www.xkww3n.cyou/2022/02/08/use-clash-dns-anti-dns-hijacking/

        let dns_config_fakeip = "
        enable: true
        listen: 127.0.0.1:8853
        default-nameserver:
            - 223.5.5.5
            - 8.8.4.4
        ipv6: false
        enhanced-mode: fake-ip
        nameserver:
            - 119.29.29.29
            - 223.5.5.5
            - tls://223.5.5.5:853
            - tls://223.6.6.6:853
        fallback:
            - https://1.0.0.1/dns-query
            - https://public.dns.iij.jp/dns-query
            - tls://8.8.4.4:853
        fallback-filter:
            geoip: false
            ipcidr:
            - 240.0.0.0/4
            - 0.0.0.0/32
            - 127.0.0.1/32
        fake-ip-filter:
            - \"*.lan\"
            - \"*.localdomain\"
            - \"*.localhost\"
            - \"*.local\"
            - \"*.home.arpa\"
            - stun.*.*
            - stun.*.*.*
            - +.stun.*.*
            - +.stun.*.*.*
            - +.stun.*.*.*.*
        ";

        let dns_config_redir_host = "
        enable: true
        ipv6: false
        listen: 127.0.0.1:8853
        default-nameserver:
            - 223.5.5.5
            - 8.8.4.4
        enhanced-mode: redir-host
        nameserver:
            - 119.29.29.29
            - 223.5.5.5
            - tls://223.5.5.5:853
            - tls://223.6.6.6:853
        fallback:
            - https://1.0.0.1/dns-query
            - https://public.dns.iij.jp/dns-query
            - tls://8.8.4.4:853
        fallback-filter:
            geoip: false
            ipcidr:
            - 240.0.0.0/4
            - 0.0.0.0/32
            - 127.0.0.1/32
        ";

        let profile_config = "
        store-selected: true
        store-fake-ip: false
        ";

        let insert_config = |yaml: &mut Mapping, config: &str, key: &str| {
            let inner_config: Value = serde_yaml::from_str(config).unwrap();
            yaml.insert(Value::String(String::from(key)), inner_config);
        };

        //开启 tun 模式
        match yaml.get("tun") {
            Some(_) => {
                yaml.remove("tun").unwrap();
                insert_config(yaml, tun_config, "tun");
            }
            None => {
                insert_config(yaml, tun_config, "tun");
            }
        }

        match yaml.get("dns") {
            Some(_) => {
                //删除 DNS 配置
                if override_dns {
                    log::info!("EnhancedMode: {:?}", enhanced_mode);
                    yaml.remove("dns").unwrap();
                    match enhanced_mode {
                        EnhancedMode::FakeIp => {
                            insert_config(yaml, dns_config_fakeip, "dns");
                        }
                        EnhancedMode::RedirHost => {
                            insert_config(yaml, dns_config_redir_host, "dns");
                        }
                    }
                }
            }
            None => {
                insert_config(yaml, dns_config_fakeip, "dns");
            }
        }

        // // 如果设置了 secret， 更改 secret 为 "tomoon"
        // let secret_config = "tomoon";
        // match yaml.get("secret") {
        //     Some(_) => {
        //         yaml.remove("secret").unwrap();
        //         insert_config(yaml, secret_config, "secret");
        //     }
        //     None => {
        //         insert_config(yaml, secret_config, "secret");
        //     }
        // }

        // 保存上次的配置
        match yaml.get("profile") {
            Some(_) => {
                yaml.remove("profile").unwrap();
                insert_config(yaml, profile_config, "profile");
            }
            None => {
                insert_config(yaml, profile_config, "profile");
            }
        }

        let run_config = self.get_running_config()?;

        let yaml_str = serde_yaml::to_string(&yaml)?;

        match fs::write(run_config, yaml_str) {
            Ok(_) => {
                log::info!("Clash config changed successfully");
            }
            Err(e) => {
                log::error!("Error occurred while changing Clash config: {}", e);
            }
        }

        log::info!("Clash config changed successfully");
        Ok(())
    }

    pub fn get_running_secret(&self) -> Result<String, Box<dyn error::Error>> {
        let path = self.get_running_config()?;
        let content = std::fs::read_to_string(path)?;
        let yaml: serde_yaml::Value = serde_yaml::from_str(&content)?;
        
        match yaml.get("secret") {
            Some(secret) => {
                Ok(secret.as_str().unwrap_or("").to_string())
            }
            None => Ok("".to_string()),
        }
    }
}

#[cfg(test)]
mod core_unit_tests {
    use super::*;

    #[test]
    fn unit_runs_as_user_with_network_caps() {
        let unit = render_core_unit(
            Path::new("/home/deck/homebrew/plugins/tomoon/bin/core/clash"),
            Path::new("/home/deck/homebrew/data/tomoon"),
            Path::new("/home/deck/homebrew/data/tomoon/running_config.yaml"),
            1000,
            1000,
        );
        assert!(unit.contains("User=1000\nGroup=1000\n"));
        assert!(unit.contains(
            "ExecStart=\"/home/deck/homebrew/plugins/tomoon/bin/core/clash\" -d \"/home/deck/homebrew/data/tomoon\" -f \"/home/deck/homebrew/data/tomoon/running_config.yaml\"\n"
        ));
        assert!(unit.contains("AmbientCapabilities=CAP_NET_ADMIN "));
        assert!(unit.contains("NoNewPrivileges=yes"));
        assert!(
            unit.contains("[Install]\nWantedBy=multi-user.target"),
            "installed service is always on and starts at boot"
        );
        assert!(!unit.contains("/../") && !unit.contains("/./"), "systemd needs normalized paths");
    }
}
