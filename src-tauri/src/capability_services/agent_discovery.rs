use std::process::Command;

use crate::{
    capability_services::agent_launch::{
        claude_bridge_availability, BridgeAvailability, CLAUDE_CODE_ACP_PACKAGE,
        CLAUDE_CODE_ACP_VERSION, CLAUDE_CODE_DISPLAY_COMMAND, CLAUDE_CODE_PRESET_ID,
        CLAUDE_CODE_PRESET_NAME,
    },
    domain::{
        AgentAvailability, AgentDiscoveryStatus, AgentDisplaySource, AgentKind, AgentLaunchMode,
        AgentRuntimePreference, UpsertAgentProfileInput,
    },
};

/// Known ACP-native Agent CLI configurations.
///
/// This is a curated local preset, not a live ACP Registry mirror.
/// We only include agents with an explicit ACP launch mode that maps cleanly
/// to a local CLI command.
pub struct KnownAcpAgent {
    pub name: &'static str,
    pub command: &'static str,
    pub args: &'static [&'static str],
    pub description: &'static str,
}

/// List of known ACP-native agents to auto-discover
pub const KNOWN_ACP_AGENTS: &[KnownAcpAgent] = &[
    KnownAcpAgent {
        name: "Gemini CLI",
        command: "gemini",
        args: &["--acp"],
        description: "Gemini CLI in ACP mode",
    },
    KnownAcpAgent {
        name: "Qwen Code",
        command: "qwen",
        args: &["--acp"],
        description: "Qwen Code CLI in ACP mode",
    },
    KnownAcpAgent {
        name: "OpenCode",
        command: "opencode",
        args: &["acp"],
        description: "OpenCode CLI in ACP mode",
    },
    KnownAcpAgent {
        name: "Goose",
        command: "goose",
        args: &["acp"],
        description: "Goose CLI in ACP mode",
    },
    KnownAcpAgent {
        name: "Kimi CLI",
        command: "kimi",
        args: &["acp"],
        description: "Kimi CLI in ACP mode",
    },
    KnownAcpAgent {
        name: "GitHub Copilot",
        command: "copilot",
        args: &["--acp", "--stdio"],
        description: "GitHub Copilot CLI in ACP mode",
    },
    KnownAcpAgent {
        name: "Qoder CLI",
        command: "qodercli",
        args: &["--acp"],
        description: "Qoder CLI in ACP mode",
    },
    KnownAcpAgent {
        name: "Cursor Agent",
        command: "agent",
        args: &["acp"],
        description: "Cursor Agent CLI in ACP mode",
    },
    KnownAcpAgent {
        name: "Kiro CLI",
        command: "kiro-cli",
        args: &["acp"],
        description: "Kiro CLI in ACP mode",
    },
    KnownAcpAgent {
        name: "Augment Code",
        command: "auggie",
        args: &["--acp"],
        description: "Augment Code CLI in ACP mode",
    },
    KnownAcpAgent {
        name: "Factory Droid",
        command: "droid",
        args: &["exec", "--output-format", "acp"],
        description: "Factory Droid CLI in ACP mode",
    },
    KnownAcpAgent {
        name: "Mistral Vibe",
        command: "vibe-acp",
        args: &[],
        description: "Mistral Vibe ACP CLI",
    },
    KnownAcpAgent {
        name: "OpenClaw",
        command: "openclaw",
        args: &["gateway"],
        description: "OpenClaw gateway mode",
    },
];

/// Check if a command exists in the system PATH
pub fn command_exists(command: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        Command::new("where")
            .arg(command)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("which")
            .arg(command)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Discover installed ACP agents and return inputs for profile creation
pub fn discover_installed_agents() -> Vec<UpsertAgentProfileInput> {
    KNOWN_ACP_AGENTS
        .iter()
        .filter(|agent| command_exists(agent.command))
        .map(|agent| UpsertAgentProfileInput {
            id: Some(format!("auto-{}", agent.command)),
            kind: AgentKind::Acp,
            name: agent.name.to_string(),
            command: agent.command.to_string(),
            args: agent.args.iter().map(|s| s.to_string()).collect(),
            env: std::collections::BTreeMap::new(),
            launch_mode: AgentLaunchMode::Native,
            runtime_preference: None,
            package_name: None,
            package_version: None,
            display_source: AgentDisplaySource::Native,
            enabled: true,
        })
        .collect()
}

pub fn claude_code_preset() -> UpsertAgentProfileInput {
    UpsertAgentProfileInput {
        id: Some(CLAUDE_CODE_PRESET_ID.to_string()),
        kind: AgentKind::Acp,
        name: CLAUDE_CODE_PRESET_NAME.to_string(),
        command: CLAUDE_CODE_DISPLAY_COMMAND.to_string(),
        args: Vec::new(),
        env: std::collections::BTreeMap::new(),
        launch_mode: AgentLaunchMode::NpmAdapter,
        runtime_preference: Some(AgentRuntimePreference::BundledBun),
        package_name: Some(CLAUDE_CODE_ACP_PACKAGE.to_string()),
        package_version: Some(CLAUDE_CODE_ACP_VERSION.to_string()),
        display_source: AgentDisplaySource::Bridge,
        enabled: true,
    }
}

/// Get discovery status for all known agents and fixed bridge presets.
pub fn get_discovery_status() -> Vec<AgentDiscoveryStatus> {
    let mut statuses: Vec<AgentDiscoveryStatus> = KNOWN_ACP_AGENTS
        .iter()
        .map(|agent| AgentDiscoveryStatus {
            name: agent.name.to_string(),
            command: agent.command.to_string(),
            installed: command_exists(agent.command),
            source: AgentDisplaySource::Native,
            availability: if command_exists(agent.command) {
                AgentAvailability::Ready
            } else {
                AgentAvailability::Unavailable
            },
            detail: None,
            profile_id: Some(format!("auto-{}", agent.command)),
        })
        .collect();
    let (availability, detail, installed) = match claude_bridge_availability() {
        BridgeAvailability::Ready => (AgentAvailability::Ready, None, true),
        BridgeAvailability::Degraded(detail) => (AgentAvailability::Degraded, Some(detail), true),
        BridgeAvailability::Unavailable(detail) => {
            (AgentAvailability::Unavailable, Some(detail), false)
        }
    };
    statuses.push(AgentDiscoveryStatus {
        name: CLAUDE_CODE_PRESET_NAME.to_string(),
        command: CLAUDE_CODE_DISPLAY_COMMAND.to_string(),
        installed,
        source: AgentDisplaySource::Bridge,
        availability,
        detail,
        profile_id: Some(CLAUDE_CODE_PRESET_ID.to_string()),
    });
    statuses
}
