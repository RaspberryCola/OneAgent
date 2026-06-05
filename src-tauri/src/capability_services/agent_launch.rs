use std::{
    collections::BTreeMap,
    path::PathBuf,
};

use crate::{
    capability_services::system_path::{
        bundled_bun_path, bundled_resources_base, command_exists, default_dev_resources_dir,
        effective_path_env,
    },
    domain::{AgentDisplaySource, AgentLaunchMode, AgentProfile, JsonMap},
};

pub const CLAUDE_CODE_ACP_PACKAGE: &str = "@agentclientprotocol/claude-agent-acp";
pub const CLAUDE_CODE_ACP_VERSION: &str = "0.37.0";
pub const CLAUDE_CODE_PRESET_ID: &str = "preset-claude-code-acp";
pub const CLAUDE_CODE_PRESET_NAME: &str = "Claude Code";
pub const CLAUDE_CODE_DISPLAY_COMMAND: &str = "claude-agent-acp";

#[derive(Debug, Clone)]
pub struct ResolvedLaunch {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: Option<PathBuf>,
    pub summary: String,
}

#[derive(thiserror::Error, Debug)]
pub enum LaunchResolutionError {
    #[error("runtime_not_found: {0}")]
    RuntimeNotFound(String),
    #[error("adapter_not_found: {0}")]
    AdapterNotFound(String),
    #[error("adapter_spawn_failed: {0}")]
    AdapterSpawnFailed(String),
}

pub type LaunchResolutionResult<T> = Result<T, LaunchResolutionError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeAvailability {
    Ready,
    Degraded(String),
    Unavailable(String),
}

pub fn resolve_launch(profile: &AgentProfile) -> LaunchResolutionResult<ResolvedLaunch> {
    match profile.launch_mode {
        AgentLaunchMode::Native => {
            let mut env = json_env_to_string_map(&profile.env);
            apply_augmented_path(&mut env);
            let (command, args) = resolve_native_command(&profile.command, &profile.args)?;
            Ok(ResolvedLaunch {
                command,
                args,
                env,
                cwd: None,
                summary: format!("native command {}", profile.command),
            })
        }
        AgentLaunchMode::NpmAdapter => resolve_npm_adapter_launch(profile),
    }
}

/// Resolve a native command, handling .ps1 files on Windows by wrapping them with powershell.
#[cfg(target_os = "windows")]
fn resolve_native_command(command: &str, args: &[String]) -> LaunchResolutionResult<(String, Vec<String>)> {
    // If the command has a .ps1 extension, wrap it with powershell
    if std::path::Path::new(command).extension().map_or(false, |ext| ext.eq_ignore_ascii_case("ps1")) {
        tracing::info!("resolve_native_command: wrapping .ps1 file '{}' with powershell", command);
        let mut wrapped_args = vec!["-ExecutionPolicy".to_string(), "Bypass".to_string(), "-File".to_string(), command.to_string()];
        wrapped_args.extend_from_slice(args);
        return Ok(("powershell".to_string(), wrapped_args));
    }

    // Try to find the actual executable to check if it's a .ps1 file
    if let Some(resolved_path) = find_executable_path(command) {
        tracing::info!("resolve_native_command: found executable '{}' for command '{}'", resolved_path.display(), command);
        
        // If the found executable has .ps1 extension, wrap it
        if resolved_path.extension().map_or(false, |ext| ext.eq_ignore_ascii_case("ps1")) {
            tracing::info!("resolve_native_command: executable is .ps1, wrapping with powershell");
            let mut wrapped_args = vec!["-ExecutionPolicy".to_string(), "Bypass".to_string(), "-File".to_string(), resolved_path.to_string_lossy().to_string()];
            wrapped_args.extend_from_slice(args);
            return Ok(("powershell".to_string(), wrapped_args));
        }
        
        // If no extension (npm sometimes creates extensionless files), check for .cmd or .ps1 siblings
        if resolved_path.extension().is_none() {
            tracing::info!("resolve_native_command: executable has no extension, checking for .cmd/.ps1 siblings");
            let parent = resolved_path.parent();
            let file_name = resolved_path.file_name().unwrap_or_default();
            
            // Prefer .cmd (native Windows) over .ps1
            if let Some(parent) = parent {
                let cmd_path = parent.join(format!("{}.cmd", file_name.to_string_lossy()));
                if cmd_path.is_file() {
                    tracing::info!("resolve_native_command: found .cmd sibling '{}'", cmd_path.display());
                    // .cmd files can be executed directly
                    return Ok((cmd_path.to_string_lossy().to_string(), args.to_vec()));
                }
                
                let ps1_path = parent.join(format!("{}.ps1", file_name.to_string_lossy()));
                if ps1_path.is_file() {
                    tracing::info!("resolve_native_command: found .ps1 sibling '{}'", ps1_path.display());
                    let mut wrapped_args = vec!["-ExecutionPolicy".to_string(), "Bypass".to_string(), "-File".to_string(), ps1_path.to_string_lossy().to_string()];
                    wrapped_args.extend_from_slice(args);
                    return Ok(("powershell".to_string(), wrapped_args));
                }
            }
            
            tracing::warn!("resolve_native_command: no .cmd/.ps1 siblings found for extensionless file");
        }
    } else {
        tracing::warn!("resolve_native_command: no executable found for command '{}'", command);
    }

    Ok((command.to_string(), args.to_vec()))
}

#[cfg(not(target_os = "windows"))]
fn resolve_native_command(command: &str, args: &[String]) -> LaunchResolutionResult<(String, Vec<String>)> {
    Ok((command.to_string(), args.to_vec()))
}

/// Find the full path of an executable by searching PATH.
#[cfg(target_os = "windows")]
fn find_executable_path(command: &str) -> Option<std::path::PathBuf> {
    use std::path::Path;
    use crate::capability_services::system_path::effective_path_dirs;

    let candidates = if command.contains(std::path::MAIN_SEPARATOR) || command.contains('/') || command.contains('\\') {
        vec![std::ffi::OsString::from(command)]
    } else {
        let path_ext = std::env::var_os("PATHEXT").unwrap_or_else(|| std::ffi::OsString::from(".COM;.EXE;.BAT;.CMD;.PS1"));
        let mut c = vec![std::ffi::OsString::from(command)];
        for ext in path_ext.to_string_lossy().split(';') {
            if !ext.is_empty() {
                c.push(std::ffi::OsString::from(format!("{}{}", command, ext)));
            }
        }
        c
    };

    effective_path_dirs().into_iter().find_map(|dir| {
        candidates.iter().find_map(|candidate| {
            let path = dir.join(candidate);
            if path.is_file() { Some(path) } else { None }
        })
    })
}

pub fn claude_bridge_availability() -> BridgeAvailability {
    if let Ok((_runtime, _adapter_entry, _working_dir)) = resolve_bundled_adapter_runtime() {
        return BridgeAvailability::Ready;
    }
    if command_exists("bunx") || command_exists("bun") || command_exists("npx") {
        return BridgeAvailability::Degraded(
            "Bundled Claude adapter is unavailable; OneAgent will fall back to system bun/node."
                .to_string(),
        );
    }
    BridgeAvailability::Unavailable(
        "Claude Code requires the bundled adapter resources or a system bun/node runtime."
            .to_string(),
    )
}

fn resolve_npm_adapter_launch(profile: &AgentProfile) -> LaunchResolutionResult<ResolvedLaunch> {
    let mut env_map = json_env_to_string_map(&profile.env);
    apply_augmented_path(&mut env_map);
    let package_name = profile
        .package_name
        .as_deref()
        .unwrap_or(CLAUDE_CODE_ACP_PACKAGE);
    let package_version = profile
        .package_version
        .as_deref()
        .unwrap_or(CLAUDE_CODE_ACP_VERSION);

    if let Ok((runtime_path, adapter_entry, working_dir)) = resolve_bundled_adapter_runtime() {
        let command = runtime_path.to_string_lossy().to_string();
        let args = vec![adapter_entry.to_string_lossy().to_string()];
        return Ok(ResolvedLaunch {
            summary: format!(
                "bundled bun runtime with {}@{} ({})",
                package_name,
                package_version,
                adapter_entry.to_string_lossy()
            ),
            command,
            args,
            env: env_map,
            cwd: Some(working_dir),
        });
    }

    if command_exists("bunx") {
        return Ok(ResolvedLaunch {
            command: "bunx".to_string(),
            args: vec![
                "--yes".to_string(),
                format!("{package_name}@{package_version}"),
            ],
            env: env_map,
            cwd: None,
            summary: format!("system bunx for {package_name}@{package_version}"),
        });
    }
    if command_exists("bun") {
        return Ok(ResolvedLaunch {
            command: "bun".to_string(),
            args: vec![
                "x".to_string(),
                "--yes".to_string(),
                format!("{package_name}@{package_version}"),
            ],
            env: env_map,
            cwd: None,
            summary: format!("system bun x for {package_name}@{package_version}"),
        });
    }
    if command_exists("npx") {
        env_map
            .entry("npm_config_yes".to_string())
            .or_insert_with(|| "true".to_string());
        return Ok(ResolvedLaunch {
            command: "npx".to_string(),
            args: vec![
                "--yes".to_string(),
                format!("{package_name}@{package_version}"),
            ],
            env: env_map,
            cwd: None,
            summary: format!("system npx for {package_name}@{package_version}"),
        });
    }

    Err(LaunchResolutionError::RuntimeNotFound(format!(
        "No bundled Bun resources were found and neither bun nor npx is available for {package_name}@{package_version}"
    )))
}

fn resolve_bundled_adapter_runtime() -> LaunchResolutionResult<(PathBuf, PathBuf, PathBuf)> {
    let runtime_path = bundled_bun_path().ok_or_else(|| {
        LaunchResolutionError::RuntimeNotFound("Bundled Bun runtime not found".to_string())
    })?;
    if !runtime_path.exists() {
        return Err(LaunchResolutionError::RuntimeNotFound(format!(
            "Bundled Bun runtime path does not exist: {}",
            runtime_path.to_string_lossy()
        )));
    }
    let adapter_root = bundled_adapter_root();
    let package_dir = adapter_root
        .join("claude-agent-acp")
        .join(CLAUDE_CODE_ACP_VERSION)
        .join("node_modules")
        .join("@agentclientprotocol")
        .join("claude-agent-acp");
    if !package_dir.exists() {
        return Err(LaunchResolutionError::AdapterNotFound(format!(
            "Bundled Claude adapter directory does not exist: {}",
            package_dir.to_string_lossy()
        )));
    }
    let package_json = package_dir.join("package.json");
    if !package_json.exists() {
        return Err(LaunchResolutionError::AdapterNotFound(format!(
            "Bundled Claude adapter package.json does not exist: {}",
            package_json.to_string_lossy()
        )));
    }
    let package_json_value = std::fs::read_to_string(&package_json).map_err(|error| {
        LaunchResolutionError::AdapterSpawnFailed(format!("Failed to read package.json: {error}"))
    })?;
    let package_json_value: serde_json::Value =
        serde_json::from_str(&package_json_value).map_err(|error| {
            LaunchResolutionError::AdapterSpawnFailed(format!(
                "Failed to parse package.json: {error}"
            ))
        })?;
    let entry_relative = package_json_value
        .get("bin")
        .and_then(|value| match value {
            serde_json::Value::String(bin) => Some(bin.as_str()),
            serde_json::Value::Object(map) => map.values().find_map(|value| value.as_str()),
            _ => None,
        })
        .ok_or_else(|| {
            LaunchResolutionError::AdapterNotFound(
                "Bundled Claude adapter has no bin entry".to_string(),
            )
        })?;
    let entry_path = package_dir.join(entry_relative);
    if !entry_path.exists() {
        return Err(LaunchResolutionError::AdapterNotFound(format!(
            "Bundled Claude adapter entry does not exist: {}",
            entry_path.to_string_lossy()
        )));
    }
    Ok((runtime_path, entry_path, package_dir))
}

fn json_env_to_string_map(env_map: &JsonMap) -> BTreeMap<String, String> {
    env_map
        .iter()
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
        .collect()
}

fn apply_augmented_path(env_map: &mut BTreeMap<String, String>) {
    if let Some(path) = effective_path_env() {
        env_map.insert("PATH".to_string(), path);
    }
}

fn bundled_adapter_root() -> PathBuf {
    bundled_resources_base()
        .unwrap_or_else(default_dev_resources_dir)
        .join("external_agents")
}

pub fn is_claude_bridge_profile(profile: &AgentProfile) -> bool {
    profile.display_source == AgentDisplaySource::Bridge
        || profile.id == CLAUDE_CODE_PRESET_ID
        || profile.package_name.as_deref() == Some(CLAUDE_CODE_ACP_PACKAGE)
}
