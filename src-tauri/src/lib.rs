mod download;
mod locate;
mod proc;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

/// What the frontend gets from `rclone_info`.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    /// "ready" | "missing" | "error"
    pub state: String,
    pub url: String,
    pub user: String,
    pub pass: String,
    pub rclone_path: String,
    pub rclone_version: String,
    pub config_path: String,
    pub log_path: String,
    pub error: String,
    pub keep_awake: bool,
}

#[derive(Default)]
pub struct Inner {
    pub info: Info,
    pub started: bool,
    pub child: Option<std::process::Child>,
    pub awake: Option<keepawake::KeepAwake>,
    pub awake_wanted: bool,
}

pub struct AppState {
    pub inner: Mutex<Inner>,
    /// Set once the frontend has called rclone_info (so it can answer close requests).
    pub frontend_ready: AtomicBool,
}

fn snapshot(state: &AppState) -> Info {
    let g = state.inner.lock().unwrap();
    let mut i = g.info.clone();
    i.keep_awake = g.awake.is_some();
    i
}

async fn ensure_started(app: &AppHandle, state: &AppState) {
    {
        let mut g = state.inner.lock().unwrap();
        if g.started {
            return;
        }
        g.started = true;
        g.awake_wanted = true;
    }
    proc::start(app, state, None).await;
}

#[tauri::command]
async fn rclone_info(app: AppHandle, state: State<'_, AppState>) -> Result<Info, String> {
    state.frontend_ready.store(true, Ordering::SeqCst);
    ensure_started(&app, &state).await;
    Ok(snapshot(&state))
}

#[tauri::command]
async fn download_rclone(app: AppHandle, state: State<'_, AppState>) -> Result<Info, String> {
    let path = download::download(&app).await?;
    proc::restart(&app, &state, Some(path)).await;
    Ok(snapshot(&state))
}

#[tauri::command]
async fn set_rclone_path(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Info, String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("File not found: {path}"));
    }
    proc::restart(&app, &state, Some(p)).await;
    let info = snapshot(&state);
    if info.state == "ready" {
        let dir = proc::app_data(&app);
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("rclone-path.txt"), &path);
    }
    Ok(info)
}

#[tauri::command]
fn open_logs_folder(app: AppHandle) -> Result<(), String> {
    let dir = proc::log_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_keep_awake(state: State<'_, AppState>, enabled: bool) -> bool {
    let mut g = state.inner.lock().unwrap();
    g.awake_wanted = enabled;
    if enabled && g.awake.is_none() {
        g.awake = proc::make_awake();
    } else if !enabled {
        g.awake = None;
    }
    g.awake.is_some()
}

#[tauri::command]
async fn quit_app(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    proc::stop(&state).await;
    app.exit(0);
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { inner: Mutex::new(Inner::default()), frontend_ready: AtomicBool::new(false) })
        .invoke_handler(tauri::generate_handler![
            rclone_info,
            download_rclone,
            set_rclone_path,
            open_logs_folder,
            set_keep_awake,
            quit_app
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let st = app.state::<AppState>();
                if st.frontend_ready.load(Ordering::SeqCst) {
                    // Let the UI decide (it confirms if a migration is running, then calls quit_app).
                    api.prevent_close();
                    let _ = app.emit("rem://close-requested", ());
                }
                // else: UI not up yet, close normally (RunEvent::Exit kills rclone).
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            proc::kill_now(&handle.state::<AppState>());
        }
    });
}
