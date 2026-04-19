use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

static SHELL_PATH_CACHE: OnceLock<Option<String>> = OnceLock::new();

fn current_username() -> Option<String> {
    if let Some(username) = env::var("USER").ok().or_else(|| env::var("USERNAME").ok()) {
        if !username.trim().is_empty() {
            return Some(username);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(output) = Command::new("id").arg("-un").output() {
            if output.status.success() {
                let username = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !username.is_empty() {
                    return Some(username);
                }
            }
        }
    }

    dirs::home_dir()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .filter(|name| !name.trim().is_empty())
}

fn resolve_login_shell() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let username = current_username()?;
        let output = Command::new("dscl")
            .args([".", "-read", &format!("/Users/{username}"), "UserShell"])
            .output()
            .ok()?;
        if !output.status.success() {
            return Some(PathBuf::from("/bin/zsh"));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let shell = stdout.split_whitespace().last()?;
        return Some(PathBuf::from(shell));
    }

    #[cfg(target_os = "linux")]
    {
        let username = current_username()?;
        let output = Command::new("getent")
            .args(["passwd", &username])
            .output()
            .ok()?;
        if !output.status.success() {
            return Some(PathBuf::from("/bin/bash"));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let shell = stdout.trim().split(':').last()?;
        return Some(PathBuf::from(shell));
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

fn resolved_login_shell_string() -> Option<String> {
    resolve_login_shell().map(|path| path.to_string_lossy().to_string())
}

fn extract_path_from_shell(shell: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new(shell)
        .args(args)
        .env("HOME", dirs::home_dir()?.to_string_lossy().to_string())
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && line.contains(std::path::MAIN_SEPARATOR))
        .map(|line| line.to_string())
}

fn load_shell_path() -> Option<String> {
    SHELL_PATH_CACHE
        .get_or_init(|| {
            let shell = resolve_login_shell()?;
            if !shell.is_absolute() {
                return None;
            }

            extract_path_from_shell(&shell, &["-l", "-c", "printenv PATH"])
                .or_else(|| extract_path_from_shell(&shell, &["-i", "-l", "-c", "printenv PATH"]))
        })
        .clone()
}

fn merge_paths(path1: Option<OsString>, path2: Option<OsString>) -> Vec<PathBuf> {
    let mut merged = Vec::new();

    for raw in [path1, path2].into_iter().flatten() {
        for path in env::split_paths(&raw) {
            if !merged.iter().any(|existing| existing == &path) {
                merged.push(path);
            }
        }
    }

    merged
}

fn fallback_path_dirs() -> Vec<PathBuf> {
    let home_dir = dirs::home_dir();
    let mut dirs = Vec::new();

    if let Some(home) = &home_dir {
        dirs.extend([
            home.join(".bun").join("bin"),
            home.join(".cargo").join("bin"),
            home.join("go").join("bin"),
            home.join(".deno").join("bin"),
            home.join(".local").join("bin"),
            home.join(".npm-global").join("bin"),
            home.join(".opencode").join("bin"),
        ]);
    }

    #[cfg(target_os = "macos")]
    {
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]);
    }

    #[cfg(target_os = "linux")]
    {
        dirs.extend([
            PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/snap/bin"),
        ]);
    }

    dirs
}

pub fn effective_path_dirs() -> Vec<PathBuf> {
    let mut dirs = merge_paths(env::var_os("PATH"), load_shell_path().map(OsString::from));

    for dir in fallback_path_dirs() {
        if dir.exists() && !dirs.iter().any(|existing| existing == &dir) {
            dirs.push(dir);
        }
    }

    dirs
}

pub fn effective_path_env() -> Option<String> {
    let dirs = effective_path_dirs();
    if dirs.is_empty() {
        return None;
    }

    let joined = env::join_paths(dirs).ok()?;
    Some(joined.to_string_lossy().to_string())
}

pub fn prime_process_path() {
    if let Some(path) = effective_path_env() {
        unsafe {
            env::set_var("PATH", path);
        }
    }
}

pub fn write_path_diagnostics(commands: &[&str]) {
    let Some(base_dir) = dirs::data_local_dir().map(|dir| dir.join("oneagent")) else {
        return;
    };
    if fs::create_dir_all(&base_dir).is_err() {
        return;
    }

    let shell_path = load_shell_path().unwrap_or_else(|| "<none>".to_string());
    let process_path = env::var("PATH").unwrap_or_else(|_| "<none>".to_string());
    let effective_path = effective_path_env().unwrap_or_else(|| "<none>".to_string());
    let home_dir = dirs::home_dir()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "<none>".to_string());
    let login_shell = resolved_login_shell_string().unwrap_or_else(|| "<none>".to_string());

    let mut lines = vec![
        format!("home={home_dir}"),
        format!("login_shell={login_shell}"),
        format!("shell_path={shell_path}"),
        format!("process_path={process_path}"),
        format!("effective_path={effective_path}"),
        "commands:".to_string(),
    ];

    for command in commands {
        lines.push(format!("{command}={}", command_exists(command)));
    }

    let _ = fs::write(base_dir.join("path-diagnostics.txt"), lines.join("\n"));
}

#[cfg(target_os = "windows")]
fn command_candidates(command: &str) -> Vec<OsString> {
    let mut candidates = Vec::new();
    let command_os = OsString::from(command);
    candidates.push(command_os.clone());

    if Path::new(command).extension().is_some() {
        return candidates;
    }

    let path_ext = env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
    for ext in path_ext.to_string_lossy().split(';') {
        if ext.is_empty() {
            continue;
        }
        candidates.push(OsString::from(format!("{command}{ext}")));
    }
    candidates
}

#[cfg(not(target_os = "windows"))]
fn command_candidates(command: &str) -> Vec<OsString> {
    vec![OsString::from(command)]
}

pub fn command_exists(command: &str) -> bool {
    if command.contains(std::path::MAIN_SEPARATOR)
        || command.contains('/')
        || command.contains('\\')
    {
        return Path::new(command).is_file();
    }

    let candidates = command_candidates(command);
    effective_path_dirs().into_iter().any(|dir| {
        candidates
            .iter()
            .map(|candidate| dir.join(candidate))
            .any(|path| path.is_file())
    })
}
