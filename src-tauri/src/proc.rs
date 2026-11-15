//! Starting, supervising and stopping the `rclone rcd` child process.

use crate::{locate, AppState, Info};
use rand::Rng;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// App data dir (REM_APP_DATA_DIR overrides it, for testing).
pub fn app_data(app: &AppHandle) -> PathBuf {
    if let Some(d) = std::env::var_os("REM_APP_DATA_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(d);
    }
    app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("rclone-easy-migration"))
}

pub fn log_dir(app: &AppHandle) -> PathBuf {
    if let Some(d) = std::env::var_os("REM_APP_DATA_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(d).join("logs");
    }
    app.path().app_log_dir().unwrap_or_else(|_| app_data(app).join("logs"))
}

pub fn make_awake() -> Option<keepawake::KeepAwake> {
    // idle sleep only; the display may still turn off
    keepawake::Builder::default()
        .idle(true)
        .display(false)
        .sleep(false)
        .reason("A file migration is in progress")
        .app_name("rclone Easy Migration")
        .app_reverse_domain("io.github.rclone-easy-migration")
        .create()
        .ok()
}

fn random_string(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::rngs::OsRng;
    (0..len).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}

fn base_command(path: &PathBuf) -> Command {
    let mut c = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c.stdin(Stdio::null());
    c
}

fn run_capture(path: &PathBuf, args: &[&str]) -> Option<String> {
    let out = base_command(path).args(args).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

fn webview_origin() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
}

#[cfg(windows)]
fn assign_to_job(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::*;
    static JOB: OnceLock<isize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if h.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            h,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        h as isize
    });
    if job != 0 {
        unsafe {
            AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
        }
    }
}

fn log_tail(path: &str) -> String {
    let Ok(text) = std::fs::read_to_string(path) else { return String::new() };
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(15)..].join("\n")
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(3)).build().unwrap()
}

async fn post_ok(url: &str, user: &str, pass: &str, method: &str) -> bool {
    client()
        .post(format!("{url}{method}"))
        .basic_auth(user, Some(pass))
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn set_info(state: &AppState, info: Info) {
    state.inner.lock().unwrap().info = info;
}

/// (Re)start rclone. `forced` = a specific rclone binary (downloaded or user-picked).
pub async fn start(app: &AppHandle, state: &AppState, forced: Option<PathBuf>) {
    let data = app_data(app);
    let Some(path) = forced.or_else(|| locate::find_rclone(&data)) else {
        set_info(state, Info { state: "missing".into(), ..Default::default() });
        return;
    };
    let mut info = Info { rclone_path: path.to_string_lossy().to_string(), ..Default::default() };

    let p2 = path.clone();
    let probe = tauri::async_runtime::spawn_blocking(move || {
        let ver = run_capture(&p2, &["version"]);
        let cfg = run_capture(&p2, &["config", "file"]);
        (ver, cfg)
    })
    .await
    .unwrap_or((None, None));
    let Some(ver) = probe.0 else {
        info.state = "error".into();
        info.error = format!("Could not run rclone at {}. Is it a valid rclone program?", info.rclone_path);
        set_info(state, info);
        return;
    };
    info.rclone_version = ver.lines().next().unwrap_or("").trim().trim_start_matches("rclone ").to_string();
    info.config_path = probe.1.and_then(|c| c.lines().map(str::trim).filter(|l| !l.is_empty()).last().map(String::from)).unwrap_or_default();

    // free port on loopback
    let port = match std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()) {
        Ok(a) => a.port(),
        Err(e) => {
            info.state = "error".into();
            info.error = format!("No free local port: {e}");
            set_info(state, info);
            return;
        }
    };
    info.user = format!("rem-{}", random_string(8).to_lowercase());
    info.pass = random_string(32);
    info.url = format!("http://127.0.0.1:{port}/");

    let logs = log_dir(app);
    let _ = std::fs::create_dir_all(&logs);
    let log_file = logs.join(format!("rclone-{}.log", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    info.log_path = log_file.to_string_lossy().to_string();
    prune_logs(&logs);

    let mut cmd = base_command(&path);
    cmd.args(["rcd", "--rc-addr", &format!("127.0.0.1:{port}"), "--rc-allow-origin", webview_origin()])
        .args(["--rc-job-expire-duration", "24h", "--log-level", "NOTICE", "--log-file"])
        .arg(&log_file)
        .env("RCLONE_RC_USER", &info.user)
        .env("RCLONE_RC_PASS", &info.pass)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                Ok(())
            });
        }
    }
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            info.state = "error".into();
            info.error = format!("Could not start rclone: {e}");
            set_info(state, info);
            return;
        }
    };
    #[cfg(windows)]
    assign_to_job(&child);
    state.inner.lock().unwrap().child = Some(child);

    // wait until the rc API answers (~15s)
    let mut ready = false;
    let mut exited = None;
    for _ in 0..75 {
        {
            let mut g = state.inner.lock().unwrap();
            if let Some(c) = g.child.as_mut() {
                if let Ok(Some(st)) = c.try_wait() {
                    exited = Some(st.to_string());
                }
            }
        }
        if exited.is_some() {
            break;
        }
        if post_ok(&info.url, &info.user, &info.pass, "core/version").await {
            ready = true;
            break;
        }
        tokio_sleep(200).await;
    }
    if ready {
        info.state = "ready".into();
        let mut g = state.inner.lock().unwrap();
        if g.awake_wanted && g.awake.is_none() {
            g.awake = make_awake();
        }
        g.info = info;
    } else {
        info.state = "error".into();
        let tail = log_tail(&info.log_path);
        info.error = match exited {
            Some(s) => format!("rclone exited unexpectedly ({s})."),
            None => "rclone did not start answering within 15 seconds.".to_string(),
        };
        if !tail.is_empty() {
            info.error.push_str("\n\n");
            info.error.push_str(&tail);
        }
        kill_now(state);
        set_info(state, info);
    }
}

async fn tokio_sleep(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms))).await;
}

/// Keep only the 20 newest rclone-*.log files.
fn prune_logs(dir: &PathBuf) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut v: Vec<_> = rd
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.starts_with("rclone-") && n.ends_with(".log")
        })
        .map(|e| e.path())
        .collect();
    v.sort();
    if v.len() > 20 {
        for p in &v[..v.len() - 20] {
            let _ = std::fs::remove_file(p);
        }
    }
}

pub async fn restart(app: &AppHandle, state: &AppState, forced: Option<PathBuf>) {
    stop(state).await;
    state.inner.lock().unwrap().started = true;
    start(app, state, forced).await;
}

/// Ask rclone to quit, then make sure it is gone.
pub async fn stop(state: &AppState) {
    let (child, info) = {
        let mut g = state.inner.lock().unwrap();
        (g.child.take(), g.info.clone())
    };
    let Some(mut child) = child else { return };
    if !info.url.is_empty() {
        post_ok(&info.url, &info.user, &info.pass, "core/quit").await;
    }
    for _ in 0..15 {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        tokio_sleep(200).await;
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Synchronous hard kill (app exit path).
pub fn kill_now(state: &AppState) {
    if let Ok(mut g) = state.inner.lock() {
        if let Some(mut c) = g.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        g.awake = None;
    }
}
