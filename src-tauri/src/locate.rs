use std::path::{Path, PathBuf};

pub fn exe_name() -> &'static str {
    if cfg!(windows) {
        "rclone.exe"
    } else {
        "rclone"
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Directory holding the app-managed rclone copy.
pub fn managed_dir(app_data: &Path) -> PathBuf {
    app_data.join("bin")
}

#[cfg(windows)]
fn extra_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(l) = env_path("LOCALAPPDATA") {
        v.push(l.join(r"Microsoft\WinGet\Links\rclone.exe"));
        // winget also unpacks into Packages\Rclone.Rclone_*\rclone-*\rclone.exe
        if let Ok(rd) = std::fs::read_dir(l.join(r"Microsoft\WinGet\Packages")) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with("Rclone.Rclone") {
                    find_exe(&e.path(), 3, &mut v);
                }
            }
        }
    }
    if let Some(u) = env_path("USERPROFILE") {
        v.push(u.join(r"scoop\shims\rclone.exe"));
    }
    if let Some(p) = env_path("ProgramData") {
        v.push(p.join(r"chocolatey\bin\rclone.exe"));
    }
    if let Some(p) = env_path("ProgramFiles") {
        v.push(p.join(r"rclone\rclone.exe"));
    }
    v.push(PathBuf::from(r"C:\rclone\rclone.exe"));
    v
}

#[cfg(windows)]
fn find_exe(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                find_exe(&p, depth - 1, out);
            } else if e.file_name().to_string_lossy().eq_ignore_ascii_case("rclone.exe") {
                out.push(p);
            }
        }
    }
}

#[cfg(not(windows))]
fn extra_candidates() -> Vec<PathBuf> {
    // GUI apps (especially on macOS) do not inherit the shell PATH, so list the usual places.
    let mut v: Vec<PathBuf> = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin", "/opt/local/bin"]
        .iter()
        .map(|d| Path::new(d).join("rclone"))
        .collect();
    if let Some(h) = env_path("HOME") {
        v.push(h.join(".local/bin/rclone"));
        v.push(h.join("bin/rclone"));
    }
    v
}

/// Find rclone. Order: RCLONE_PATH -> PATH -> common locations -> app-managed copy (last).
/// REM_SKIP_SYSTEM_RCLONE=1 (testing) skips everything except the app-managed copy.
pub fn find_rclone(app_data: &Path) -> Option<PathBuf> {
    let skip = std::env::var_os("REM_SKIP_SYSTEM_RCLONE").is_some_and(|v| !v.is_empty() && v != "0");
    if !skip {
        if let Some(p) = env_path("RCLONE_PATH") {
            if p.is_file() {
                return Some(p);
            }
        }
        if let Some(path) = std::env::var_os("PATH") {
            for d in std::env::split_paths(&path) {
                if d.as_os_str().is_empty() {
                    continue;
                }
                let p = d.join(exe_name());
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        for p in extra_candidates() {
            if p.is_file() {
                return Some(p);
            }
        }
    }
    // a file the user picked in the setup screen
    if let Ok(t) = std::fs::read_to_string(app_data.join("rclone-path.txt")) {
        let p = PathBuf::from(t.trim());
        if !t.trim().is_empty() && p.is_file() {
            return Some(p);
        }
    }
    let m = managed_dir(app_data).join(exe_name());
    if m.is_file() {
        return Some(m);
    }
    None
}
