use crate::{
    capability_services::{
        agent_discovery::{claude_code_preset, discover_installed_agents, get_discovery_status},
        agent_launch::is_claude_bridge_profile,
    },
    domain::{AgentDiscoveryStatus, AgentProfile, UpsertAgentProfileInput},
    storage::Database,
};

use super::{ApplicationError, ApplicationResult};

#[derive(Clone)]
pub struct AgentAppService {
    db: Database,
}

impl AgentAppService {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    fn do_refresh_agent_discovery(&self) -> ApplicationResult<Vec<AgentProfile>> {
        let discovered = discover_installed_agents();
        let discovered_ids = discovered
            .iter()
            .filter_map(|input| input.id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        let existing_profiles = self.db.list_agent_profiles()?;
        for profile in existing_profiles {
            if profile.id.starts_with("auto-")
                && !discovered_ids.contains(&profile.id)
                && !is_claude_bridge_profile(&profile)
                && !self.db.is_agent_profile_referenced(&profile.id)?
            {
                self.db.delete_agent_profile(&profile.id)?;
            }
        }
        let mut profiles = Vec::with_capacity(discovered.len() + 1);
        profiles.push(self.db.upsert_agent_profile(claude_code_preset())?);
        for input in discovered {
            profiles.push(self.db.upsert_agent_profile(input)?);
        }
        Ok(profiles)
    }

    pub fn refresh_agent_discovery(&self) -> ApplicationResult<Vec<AgentProfile>> {
        self.do_refresh_agent_discovery()
    }

    pub fn list_agent_profiles(&self) -> ApplicationResult<Vec<AgentProfile>> {
        self.refresh_agent_discovery()?;
        Ok(self.db.list_agent_profiles()?)
    }

    pub fn list_agent_discovery_status(&self) -> ApplicationResult<Vec<AgentDiscoveryStatus>> {
        self.refresh_agent_discovery()?;
        let profiles = self.db.list_agent_profiles()?;
        let discovery = get_discovery_status();
        Ok(discovery
            .into_iter()
            .map(|mut status| {
                status.profile_id = profiles
                    .iter()
                    .find(|p| {
                        p.id == status.profile_id.clone().unwrap_or_default()
                            || (p.command == status.command && p.name == status.name)
                    })
                    .map(|p| p.id.clone());
                status
            })
            .collect())
    }

    pub fn upsert_agent_profile(
        &self,
        input: UpsertAgentProfileInput,
    ) -> ApplicationResult<AgentProfile> {
        if input.command.trim().is_empty() {
            return Err(ApplicationError::Validation(
                "agent command cannot be empty".to_string(),
            ));
        }
        Ok(self.db.upsert_agent_profile(input)?)
    }
}
