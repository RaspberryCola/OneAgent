use std::{
    collections::BTreeMap,
    env,
    path::{Path, PathBuf},
};

use crate::{
    capability_services::system_path::{command_exists, effective_path_env},
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
            Ok(ResolvedLaunch {
                command: profile.command.clone(),
                args: profile.args.clone(),
                env,
                cwd: None,
                summary: format!("native command {}", profile.command),
            })
        }
        AgentLaunchMode::NpmAdapter => resolve_npm_adapter_launch(profile),
    }
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

fn bundled_bun_path() -> Option<PathBuf> {
    let executable_name = if cfg!(windows) { "bun.exe" } else { "bun" };
    let platform_key = bundled_runtime_key();
    let base = bundled_resources_base()?;
    Some(
        base.join("bundled-bun")
            .join(platform_key)
            .join(executable_name),
    )
}

fn bundled_adapter_root() -> PathBuf {
    bundled_resources_base()
        .unwrap_or_else(default_dev_resources_dir)
        .join("external_agents")
}

fn bundled_runtime_key() -> &'static str {
    match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("linux", "x86_64") => "linux-x64",
        ("windows", "x86_64") => "win32-x64",
        _ => "unsupported",
    }
}

fn bundled_resources_base() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let candidates = if cfg!(target_os = "macos") {
        // macOS .app bundle structure:
        // OneAgent.app/Contents/MacOS/oneagent (exe)
        // OneAgent.app/Contents/Resources/resources/bundled-bun/... (actual location)
        vec![
            exe_dir
                .parent()
                .map(|path| path.join("Resources").join("resources")), // Production: Contents/Resources/resources
            exe_dir.parent().map(|path| path.join("Resources")), // Alternative: Contents/Resources
            Some(default_dev_resources_dir()),                   // Development
        ]
    } else {
        vec![
            Some(exe_dir.join("resources")),
            Some(exe_dir.join("../resources")),
            Some(default_dev_resources_dir()),
        ]
    };
    candidates.into_iter().flatten().find(|path| path.exists())
}

fn default_dev_resources_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("resources")
}

pub fn is_claude_bridge_profile(profile: &AgentProfile) -> bool {
    profile.display_source == AgentDisplaySource::Bridge
        || profile.id == CLAUDE_CODE_PRESET_ID
        || profile.package_name.as_deref() == Some(CLAUDE_CODE_ACP_PACKAGE)
}
