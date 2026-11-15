//! Download + verify + install an app-managed rclone copy.

use crate::{locate, proc};
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

const BASE: &str = "https://downloads.rclone.org";

#[derive(Serialize, Clone)]
struct Progress {
    stage: &'static str,
    received: u64,
    total: u64,
}

fn emit(app: &AppHandle, stage: &'static str, received: u64, total: u64) {
    let _ = app.emit("rclone-download-progress", Progress { stage, received, total });
}

fn platform() -> Result<(&'static str, &'static str), String> {
    let os = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "osx",
        "linux" => "linux",
        o => return Err(format!("Unsupported operating system: {o}")),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "x86" => "386",
        "arm" => "arm-v7",
        a => return Err(format!("Unsupported CPU architecture: {a}")),
    };
    Ok((os, arch))
}

pub async fn download(app: &AppHandle) -> Result<PathBuf, String> {
    let (os, arch) = platform()?;
    let http = reqwest::Client::builder()
        .user_agent("rclone-easy-migration")
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let get_text = |url: String| {
        let http = http.clone();
        async move {
            let r = http.get(&url).send().await.map_err(|e| format!("Could not reach {url}: {e}"))?;
            if !r.status().is_success() {
                return Err(format!("{url} answered HTTP {}", r.status()));
            }
            r.text().await.map_err(|e| e.to_string())
        }
    };

    emit(app, "lookup", 0, 0);
    let ver_txt = get_text(format!("{BASE}/version.txt")).await?;
    let ver = ver_txt.trim().trim_start_matches("rclone").trim().to_string();
    let valid = ver.starts_with('v') && ver[1..].split('.').count() == 3 && ver[1..].chars().all(|c| c.is_ascii_digit() || c == '.');
    if !valid {
        return Err(format!("Unexpected version string from downloads.rclone.org: '{ver}'"));
    }
    let name = format!("rclone-{ver}-{os}-{arch}.zip");

    let sums = get_text(format!("{BASE}/{ver}/SHA256SUMS")).await?;
    let expected = sums
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let h = it.next()?;
            let n = it.next()?.trim_start_matches('*');
            (n == name && h.len() == 64).then(|| h.to_lowercase())
        })
        .next()
        .ok_or_else(|| format!("No checksum for {name} in SHA256SUMS"))?;

    let resp = http
        .get(format!("{BASE}/{ver}/{name}"))
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut buf: Vec<u8> = Vec::with_capacity(total as usize);
    let mut hasher = Sha256::new();
    let mut stream = resp.bytes_stream();
    let mut last = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
        hasher.update(&chunk);
        buf.extend_from_slice(&chunk);
        if last.elapsed().as_millis() > 100 {
            emit(app, "download", buf.len() as u64, total);
            last = std::time::Instant::now();
        }
    }
    emit(app, "download", buf.len() as u64, total);
    emit(app, "verify", 0, 0);
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        return Err(format!("Checksum mismatch for {name} (expected {expected}, got {actual}). Nothing was installed."));
    }

    emit(app, "install", 0, 0);
    let dest_dir = locate::managed_dir(&proc::app_data(app));
    let exe = locate::exe_name();
    let dest = dest_dir.join(exe);
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(buf)).map_err(|e| format!("Bad archive: {e}"))?;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
            let fname = f.name().rsplit('/').next().unwrap_or("").to_string();
            if f.is_file() && fname == exe {
                let mut out = Vec::new();
                f.read_to_end(&mut out).map_err(|e| e.to_string())?;
                return Ok(out);
            }
        }
        Err(format!("{exe} not found in the downloaded archive"))
    })
    .await
    .map_err(|e| e.to_string())??;

    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("Cannot create {}: {e}", dest_dir.display()))?;
    let tmp = dest_dir.join(format!("{exe}.part"));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    let _ = std::fs::remove_file(&dest);
    std::fs::rename(&tmp, &dest).map_err(|e| format!("Cannot install rclone: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("xattr").args(["-d", "com.apple.quarantine"]).arg(&dest).output();
    }
    emit(app, "done", 0, 0);
    Ok(dest)
}
