use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Arc;
use uuid::Uuid;

use crate::domain::{
    AgentProfile, UpsertAgentProfileInput, AgentCapabilities,
};
use crate::storage::error::{StorageError, StorageResult};
use crate::storage::mappers::agent_profile::read_agent_profile;
use crate::storage::mappers::{enum_text, to_json};

pub struct AgentProfileRepository<'a> {
    conn: &'a Arc<Mutex<Connection>>,
}

impl<'a> AgentProfileRepository<'a> {
    pub fn new(conn: &'a Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    pub fn list(&self) -> StorageResult<Vec<AgentProfile>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, kind, name, command, args_json, env_json, launch_mode, runtime_preference, package_name, package_version, display_source, capabilities_cache_json, enabled FROM agent_profiles ORDER BY name",
        )?;
        let rows = stmt.query_map([], read_agent_profile)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn upsert(&self, input: UpsertAgentProfileInput) -> StorageResult<AgentProfile> {
        let profile_id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let existing_capabilities = self
            .conn
            .lock()
            .query_row(
                "SELECT capabilities_cache_json FROM agent_profiles WHERE id = ?1",
                params![profile_id.clone()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        let profile = AgentProfile {
            id: profile_id,
            kind: input.kind,
            name: input.name,
            command: input.command,
            args: input.args,
            env: input.env,
            launch_mode: input.launch_mode,
            runtime_preference: input.runtime_preference,
            package_name: input.package_name,
            package_version: input.package_version,
            display_source: input.display_source,
            capabilities_cache: existing_capabilities,
            enabled: input.enabled,
        };
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO agent_profiles (
              id, kind, name, command, args_json, env_json, launch_mode, runtime_preference,
              package_name, package_version, display_source, capabilities_cache_json, enabled
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(id) DO UPDATE SET
              kind = excluded.kind,
              name = excluded.name,
              command = excluded.command,
              args_json = excluded.args_json,
              env_json = excluded.env_json,
              launch_mode = excluded.launch_mode,
              runtime_preference = excluded.runtime_preference,
              package_name = excluded.package_name,
              package_version = excluded.package_version,
              display_source = excluded.display_source,
              enabled = excluded.enabled
            "#,
            params![
                profile.id,
                enum_text(&profile.kind),
                profile.name,
                profile.command,
                to_json(&profile.args)?,
                to_json(&profile.env)?,
                enum_text(&profile.launch_mode),
                profile.runtime_preference.as_ref().map(enum_text),
                profile.package_name,
                profile.package_version,
                enum_text(&profile.display_source),
                profile.capabilities_cache.to_string(),
                profile.enabled as i64
            ],
        )?;
        Ok(profile)
    }

    pub fn update_capabilities(
        &self,
        profile_id: &str,
        capabilities: &AgentCapabilities,
    ) -> StorageResult<()> {
        self.conn.lock().execute(
            "UPDATE agent_profiles SET capabilities_cache_json = ?2 WHERE id = ?1",
            params![profile_id, serde_json::to_string(capabilities)?],
        )?;
        Ok(())
    }

    pub fn delete(&self, profile_id: &str) -> StorageResult<()> {
        self.conn.lock().execute(
            "DELETE FROM agent_profiles WHERE id = ?1",
            params![profile_id],
        )?;
        Ok(())
    }

    pub fn is_referenced(&self, profile_id: &str) -> StorageResult<bool> {
        let count: i64 = self.conn.lock().query_row(
            "SELECT COUNT(1) FROM conversations WHERE agent_profile_id = ?1",
            params![profile_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn get(&self, profile_id: &str) -> StorageResult<AgentProfile> {
        self.conn
            .lock()
            .query_row(
                "SELECT id, kind, name, command, args_json, env_json, launch_mode, runtime_preference, package_name, package_version, display_source, capabilities_cache_json, enabled FROM agent_profiles WHERE id = ?1",
                params![profile_id],
                read_agent_profile,
            )
            .map_err(|_| StorageError::NotFound(format!("agent profile {profile_id}")))
    }
}
