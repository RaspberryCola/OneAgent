use std::process::Command;

use crate::domain::{AgentKind, UpsertAgentProfileInput};

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
            enabled: true,
        })
        .collect()
}

/// Get discovery status for all known agents (for UI display)
pub fn get_discovery_status() -> Vec<(String, String, bool)> {
    KNOWN_ACP_AGENTS
        .iter()
        .map(|agent| {
            (
                agent.name.to_string(),
                agent.command.to_string(),
                command_exists(agent.command),
            )
        })
        .collect()
}
