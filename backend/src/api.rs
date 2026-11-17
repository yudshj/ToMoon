use std::{fs, path::PathBuf, thread};

use crate::{
    control::{DownloadStatus, RunningStatus},
    helper,
    settings::{State, Subscription},
};

use super::control::ControlRuntime;

use rand::{distributions::Alphanumeric, Rng};
use usdpl_back::core::serdes::Primitive;

pub const VERSION: &'static str = env!("CARGO_PKG_VERSION");
pub const NAME: &'static str = env!("CARGO_PKG_NAME");

/// Whether the TUN transparent proxy is on (service running + `enable`).
pub fn get_clash_status(runtime: &ControlRuntime) -> impl Fn(Vec<Primitive>) -> Vec<Primitive> {
    let runtime_settings = runtime.settings_clone();
    move |_| {
        let enabled = match runtime_settings.read() {
            Ok(x) => x.enable,
            Err(e) => {
                log::error!("get_enable failed to acquire settings read lock: {}", e);
                return vec![false.into()];
            }
        };
        let status = enabled && helper::is_clash_running();
        log::debug!("get clash status with {}", status);
        vec![status.into()]
    }
}

/// Turn the TUN transparent proxy on/off in the always-on core. The service
/// itself is only installed/removed via the install/uninstall endpoints.
pub fn set_clash_status(runtime: &ControlRuntime) -> impl Fn(Vec<Primitive>) -> Vec<Primitive> {
    let runtime_settings = runtime.settings_clone();
    let runtime_state = runtime.state_clone();
    let clash = runtime.clash_state_clone();
    let running_status = runtime.running_status_clone();
    move |params| {
        let Some(Primitive::Bool(enabled)) = params.get(0) else {
            return vec![false.into()];
        };
        let enabled = *enabled;
        log::info!("set clash status (TUN) to {}", enabled);
        if let Ok(mut s) = running_status.write() {
            *s = RunningStatus::Loading;
        }
        let finish = |ok: bool| {
            if let Ok(mut s) = running_status.write() {
                *s = if ok { RunningStatus::Success } else { RunningStatus::Failed };
            }
        };

        if !crate::control::core_service_installed() {
            log::error!("system service is not installed");
            finish(false);
            return vec![false.into()];
        }

        let (Ok(mut settings), Ok(mut clash)) = (runtime_settings.write(), clash.write()) else {
            log::error!("set_clash_status failed to acquire locks");
            finish(false);
            return vec![false.into()];
        };
        // 有些时候第一次没有选择订阅
        if settings.current_sub.is_empty() {
            match settings.subscriptions.get(0) {
                Some(sub) => settings.current_sub = sub.path.clone(),
                None => {
                    log::error!("no profile provided.");
                    finish(false);
                    return vec![false.into()];
                }
            }
        }

        let previous = settings.enable;
        settings.enable = enabled;
        if let Err(e) = clash.apply(&settings) {
            log::error!("Apply clash config error: {}", e);
            settings.enable = previous;
            finish(false);
            return vec![false.into()];
        }
        if !enabled {
            if let Err(e) = helper::reset_system_network() {
                log::error!("reset network error: {}", e);
            }
        }
        if let Ok(mut state) = runtime_state.write() {
            state.dirty = true;
        }
        finish(true);
        vec![enabled.into()]
    }
}

pub fn reset_network() -> impl Fn(Vec<Primitive>) -> Vec<Primitive> {
    |_| {
        match helper::reset_system_network() {
            Ok(_) => (),
            Err(e) => {
                log::error!("Error occured while reset_network() : {}", e);
                return vec![];
            }
        }
        log::info!("Successfully reset network");
        return vec![];
    }
}

pub fn download_sub(runtime: &ControlRuntime) -> impl Fn(Vec<Primitive>) -> Vec<Primitive> {
    let download_status = runtime.downlaod_status_clone();
    let runtime_state = runtime.state_clone();
    let runtime_setting = runtime.settings_clone();
    move |params| {
        if let Some(Primitive::String(url)) = params.get(0) {
            match download_status.write() {
                Ok(mut x) => {
                    let path = match runtime_state.read() {
                        Ok(x) => x.home.as_path().join(".config/tomoon/subs/"),
                        Err(e) => {
                            log::error!("download_sub() faild to acquire state read {}", e);
                            return vec![];
                        }
                    };
                    *x = DownloadStatus::Downloading;
                    //新线程复制准备
                    let url = url.clone();
                    let download_status = download_status.clone();
                    let runtime_setting = runtime_setting.clone();
                    let runtime_state = runtime_state.clone();
                    //开始下载
                    thread::spawn(move || {
                        let update_status = |status: DownloadStatus| {
                            //修改下载状态
                            match download_status.write() {
                                Ok(mut x) => {
                                    *x = status;
                                }
                                Err(e) => {
                                    log::error!(
                                        "download_sub() faild to acquire download_status write {}",
                                        e
                                    );
                                }
                            }
                        };
                        //是一个本地文件
                        if let Some(local_file) = helper::get_file_path(url.clone()) {
                            let local_file = PathBuf::from(local_file);
                            if local_file.exists() {
                                let file_content = match fs::read_to_string(local_file) {
                                    Ok(x) => x,
                                    Err(e) => {
                                        log::error!("Failed while creating sub dir.");
                                        log::error!("Error Message:{}", e);
                                        update_status(DownloadStatus::Error);
                                        return;
                                    }
                                };
                                if !helper::check_yaml(&file_content) {
                                    log::error!(
                                        "The downloaded subscription is not a legal profile."
                                    );
                                    update_status(DownloadStatus::Error);
                                    return;
                                }
                                //保存订阅
                                let s: String = rand::thread_rng()
                                    .sample_iter(&Alphanumeric)
                                    .take(5)
                                    .map(char::from)
                                    .collect();
                                let path = path.join(s + ".yaml");
                                if let Some(parent) = path.parent() {
                                    if let Err(e) = std::fs::create_dir_all(parent) {
                                        log::error!("Failed while creating sub dir.");
                                        log::error!("Error Message:{}", e);
                                        update_status(DownloadStatus::Error);
                                        return;
                                    }
                                }
                                let path = path.to_str().unwrap();
                                if let Err(e) = fs::write(path, file_content) {
                                    log::error!("Failed while saving sub, path: {}", path);
                                    log::error!("Error Message:{}", e);
                                    return;
                                }
                                //修改下载状态
                                log::info!("Download profile successfully.");
                                update_status(DownloadStatus::Success);
                                //存入设置
                                match runtime_setting.write() {
                                    Ok(mut x) => {
                                        x.subscriptions
                                            .push(Subscription::new(path.to_string(), url.clone()));
                                        let mut state = match runtime_state.write() {
                                            Ok(x) => x,
                                            Err(e) => {
                                                log::error!("set_enable failed to acquire state write lock: {}", e);
                                                update_status(DownloadStatus::Error);
                                                return;
                                            }
                                        };
                                        state.dirty = true;
                                    }
                                    Err(e) => {
                                        log::error!(
                                        "download_sub() faild to acquire runtime_setting write {}",
                                        e
                                    );
                                        update_status(DownloadStatus::Error);
                                    }
                                }
                            } else {
                                log::error!("Cannt found file {}", local_file.to_str().unwrap());
                                update_status(DownloadStatus::Error);
                                return;
                            }
                            // 是一个链接
                        } else {
                            match helper::http_get(&url)
                                .with_header(
                                    "User-Agent",
                                    format!("ToMoonClash/{}", env!("CARGO_PKG_VERSION")),
                                )
                                .with_timeout(15)
                                .send()
                            {
                                Ok(x) => {
                                    let response = x.as_str().unwrap();
                                    if !helper::check_yaml(&String::from(response)) {
                                        log::error!(
                                            "The downloaded subscription is not a legal profile."
                                        );
                                        update_status(DownloadStatus::Error);
                                        return;
                                    }
                                    let s: String = rand::thread_rng()
                                        .sample_iter(&Alphanumeric)
                                        .take(5)
                                        .map(char::from)
                                        .collect();
                                    let path = path.join(s + ".yaml");
                                    //保存订阅
                                    if let Some(parent) = path.parent() {
                                        if let Err(e) = std::fs::create_dir_all(parent) {
                                            log::error!("Failed while creating sub dir.");
                                            log::error!("Error Message:{}", e);
                                            update_status(DownloadStatus::Error);
                                            return;
                                        }
                                    }
                                    let path = path.to_str().unwrap();
                                    if let Err(e) = fs::write(path, response) {
                                        log::error!("Failed while saving sub.");
                                        log::error!("Error Message:{}", e);
                                    }
                                    //下载成功
                                    //修改下载状态
                                    log::info!("Download profile successfully.");
                                    update_status(DownloadStatus::Success);
                                    //存入设置
                                    match runtime_setting.write() {
                                        Ok(mut x) => {
                                            x.subscriptions
                                                .push(Subscription::new(path.to_string(), url));
                                            let mut state = match runtime_state.write() {
                                                Ok(x) => x,
                                                Err(e) => {
                                                    log::error!("set_enable failed to acquire state write lock: {}", e);
                                                    update_status(DownloadStatus::Error);
                                                    return;
                                                }
                                            };
                                            state.dirty = true;
                                        }
                                        Err(e) => {
                                            log::error!(
                                        "download_sub() faild to acquire runtime_setting write {}",
                                        e
                                    );
                                            update_status(DownloadStatus::Error);
                                        }
                                    }
                                }
                                Err(e) => {
                                    log::error!("Failed while downloading sub.");
                                    log::error!("Error Message:{}", e);
                                    update_status(DownloadStatus::Failed);
                                }
                            };
                        }
                    });
                }
                Err(_) => {
                    log::error!("download_sub() faild to acquire state write");
                    return vec![];
                }
            }
        } else {
        }
        return vec![];
    }
}

pub fn get_download_status(runtime: &ControlRuntime) -> impl Fn(Vec<Primitive>) -> Vec<Primitive> {
    let download_status = runtime.downlaod_status_clone();
    move |_| {
        match download_status.read() {
            Ok(x) => {
                let status = x.to_string();
                return vec![status.into()];
            }
            Err(_) => {
                log::error!("Error occured while get_download_status()");
            }
        }
        return vec![];
    }
}

pub fn get_running_status(runtime: &ControlRuntime) -> impl Fn(Vec<Primitive>) -> Vec<Primitive> {
    let running_status = runtime.running_status_clone();
    move |_| {
        match running_status.read() {
            Ok(x) => {
                let status = x.to_string();
                return vec![status.into()];
            }
            Err(_) => {
                log::error!("Error occured while get_running_status()");
            }
        }
        return vec![];
    }
}

pub fn get_sub_list(runtime: &ControlRuntime) -> impl Fn(Vec<Primitive>) -> Vec<Primitive> {
    let runtime_setting = runtime.settings_clone();
    move |_| {
        match runtime_setting.read() {
            Ok(x) => {
                match serde_json::to_string(&x.subscriptions) {
                    Ok(x) => {
                        //返回 json 编码的订阅
                        return vec![x.into()];
                    }
                    Err(e) => {
                        log::error!("Error while serializing data structures");
                        log::error!("Error message: {}", e);
                        return vec![];
                    }
                };
            }
            Err(e) => {
                log::error!(
                    "get_sub_list() faild to acquire runtime_setting write {}",
                    e
                );
            }
        }
        return vec![];
    }
}

// get_current_sub 获取当前订阅
pub fn get_current_sub(runtime: &ControlRuntime) -> impl Fn(Vec<Primitive>) -> Vec<Primitive> {
    let runtime_setting = runtime.settings_clone();
    move |_| {
        match runtime_setting.read() {
            Ok(x) => {
                return vec![x.current_sub.clone().into()];
            }
            Err(e) => {
                log::error!("get_current_sub() faild , {}", e);
            }
        }
        return vec![];
    }
}

pub fn delete_sub(runtime: &ControlRuntime) -> impl Fn(Vec<Primitive>) -> Vec<Primitive> {
    let runtime_setting = runtime.settings_clone();
    let runtime_state = runtime.state_clone();
    move |params| {
        if let Some(Primitive::F64(id)) = params.get(0) {
            match runtime_setting.write() {
                Ok(mut x) => {
                    if let Some(item) = x.subscriptions.get(*id as usize) {
                        match fs::remove_file(item.path.as_str()) {
                            Ok(_) => {}
                            Err(e) => {
                                log::error!("delete file error: {}", e);
                            }
                        }
                    }
                    if let Some(item) = x.subscriptions.get(*id as usize) {
                        if x.current_sub == item.path {
                            x.current_sub = "".to_string();
                        }
                        x.subscriptions.remove(*id as usize);
                    }
                    //log::info!("delete {:?}", x.subscriptions.get(*id as usize).unwrap());
                    drop(x);
                    let mut state = match runtime_state.write() {
                        Ok(x) => x,
                        Err(e) => {
                            log::error!("set_enable failed to acquire state write lock: {}", e);
                            return vec![];
                        }
                    };
                    state.dirty = true;
                }
                Err(e) => {
                    log::error!("delete_sub() faild to acquire runtime_setting write {}", e);
                }
            }
        }
        return vec![];
    }
}

pub fn set_sub(runtime: &ControlRuntime) -> impl Fn(Vec<Primitive>) -> Vec<Primitive> {
    let runtime_clash = runtime.clash_state_clone();
    let runtime_state = runtime.state_clone();
    let runtime_setting = runtime.settings_clone();
    move |params: Vec<Primitive>| {
        if let Some(Primitive::String(path)) = params.get(0) {
            //更新到配置文件中
            match runtime_setting.write() {
                Ok(mut x) => {
                    x.current_sub = (*path).clone();
                    let mut state = match runtime_state.write() {
                        Ok(x) => x,
                        Err(e) => {
                            log::error!("set_sub failed to acquire state write lock: {}", e);
                            return vec![];
                        }
                    };
                    state.dirty = true;
                    drop(x);
                    drop(state);
                }
                Err(e) => {
                    log::error!("get_enable failed to acquire settings read lock: {}", e);
                    return vec![];
                }
            };
            //更新到当前内存中
            match runtime_clash.write() {
                Ok(mut x) => {
                    x.update_config_path(path);
                    log::info!("set profile path to {}", path);
                }
                Err(e) => {
                    log::error!("set_sub() failed to acquire clash write lock: {}", e);
                }
            }
        }
        return vec![];
    }
}

pub fn update_subs(runtime: &ControlRuntime) -> impl Fn(Vec<Primitive>) -> Vec<Primitive> {
    let runtime_update_status = runtime.update_status_clone();
    let runtime_setting = runtime.settings_clone();
    move |_| {
        if let Ok(mut x) = runtime_update_status.write() {
            *x = DownloadStatus::Downloading;
            drop(x);
            if let Ok(v) = runtime_setting.write() {
                let subs = v.subscriptions.clone();
                drop(v);
                let runtime_update_status = runtime_update_status.clone();
                thread::spawn(move || {
                    for i in subs {
                        //是一个本地文件
                        if helper::get_file_path(i.url.clone()).is_some() {
                            continue;
                        }
                        thread::spawn(move || {
                            match helper::http_get(&i.url)
                                .with_header(
                                    "User-Agent",
                                    format!(
                                        "ToMoon/{} mihomo/1.18.3 Clash/v1.18.0",
                                        env!("CARGO_PKG_VERSION")
                                    ),
                                )
                                .with_timeout(15)
                                .send()
                            {
                                Ok(response) => {
                                    let response = match response.as_str() {
                                        Ok(x) => x,
                                        Err(_) => {
                                            log::error!("Error occurred while parsing response.");
                                            return;
                                        }
                                    };
                                    if !helper::check_yaml(&response.to_string()) {
                                        log::error!(
                                            "The downloaded subscription is not a legal profile."
                                        );
                                        return;
                                    }
                                    match fs::write(i.path.clone(), response) {
                                        Ok(_) => {
                                            log::info!("Subscription {} updated.", i.path);
                                        }
                                        Err(e) => {
                                            log::error!(
                                        "Error occurred while write to file in update_subs(). {}",
                                        e
                                    );
                                            return;
                                        }
                                    }
                                }
                                Err(e) => {
                                    log::error!("Error occurred while download sub {}", i.url);
                                    log::error!("Error Message : {}", e);
                                }
                            }
                        });
                    }
                    //下载执行完毕
                    if let Ok(mut x) = runtime_update_status.write() {
                        *x = DownloadStatus::Success;
                    } else {
                        log::error!(
                            "Error occurred while acquire runtime_update_status write lock."
                        );
                    }
                });
            }
        }
        return vec![];
    }
}

pub fn get_update_status(runtime: &ControlRuntime) -> impl Fn(Vec<Primitive>) -> Vec<Primitive> {
    let update_status = runtime.update_status_clone();
    move |_| {
        match update_status.read() {
            Ok(x) => {
                let status = x.to_string();
                return vec![status.into()];
            }
            Err(_) => {
                log::error!("Error occured while get_update_status()");
            }
        }
        return vec![];
    }
}

pub fn create_debug_log(runtime: &ControlRuntime) -> impl Fn(Vec<Primitive>) -> Vec<Primitive> {
    //let update_status = runtime.update_status_clone();
    let home = match runtime.state_clone().read() {
        Ok(state) => state.home.clone(),
        Err(_) => State::default().home,
    };
    move |_| {
        let running_status = format!("Clash status : {}\n", helper::is_clash_running());
        let tomoon_config = match fs::read_to_string(home.join(".config/tomoon/tomoon.json")) {
            Ok(x) => x,
            Err(e) => {
                format!("can not get Tomoon config, error message: {} \n", e)
            }
        };
        let tomoon_log = match fs::read_to_string("/tmp/tomoon.log") {
            Ok(x) => x,
            Err(e) => {
                format!("can not get Tomoon log, error message: {} \n", e)
            }
        };
        let clash_log = match std::process::Command::new("journalctl")
            .args(["-u", crate::control::CORE_SERVICE, "-n", "300", "--no-pager"])
            .output()
        {
            Ok(x) => String::from_utf8_lossy(&x.stdout).into_owned(),
            Err(e) => {
                format!("can not get Clash log, error message: {} \n", e)
            }
        };

        let log = format!(
            "
        {}\n
        ToMoon config:\n
        {}\n
        ToMoon log:\n
        {}\n
        Clash log:\n
        {}\n
        ",
            running_status, tomoon_config, tomoon_log, clash_log,
        );
        fs::write("/tmp/tomoon.debug.log", log).unwrap();
        return vec![true.into()];
    }
}
