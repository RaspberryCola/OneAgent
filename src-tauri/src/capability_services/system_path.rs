use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
};

fn fallback_path_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

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
    let mut dirs = Vec::new();

    if let Some(path_value) = env::var_os("PATH") {
        dirs.extend(env::split_paths(&path_value));
    }

    for dir in fallback_path_dirs() {
        if !dirs.iter().any(|existing| existing == &dir) {
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

#[cfg(target_os = "windows")]
fn command_candidates(command: &str) -> Vec<OsString> {
    let mut candidates = Vec::new();
    let command_os = OsString::from(command);
    candidates.push(command_os.clone());

    if Path::new(command).extension().is_some() {
        return candidates;
    }

    let path_ext = env::var_os("PATHEXT")
        .unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
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
    if command.contains(std::path::MAIN_SEPARATOR) || command.contains('/') || command.contains('\\')
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
