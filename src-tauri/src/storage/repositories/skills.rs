use rusqlite::{params, Connection};

use crate::domain::{Workspace, SkillRecord, SkillScope};
use crate::storage::error::StorageResult;
use crate::storage::mappers::skill::read_skill;
use crate::storage::mappers::enum_text;

pub struct SkillRepository<'a> {
    conn: &'a Connection,
}

impl<'a> SkillRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn replace_workspace_skills(
        &self,
        workspace: &Workspace,
        skills: &[SkillRecord],
    ) -> StorageResult<()> {
        let conn = self.conn;
        conn.execute(
            "DELETE FROM skill_records WHERE scope = 'project' OR scope = 'agent_specific'",
            [],
        )?;
        for skill in skills {
            let enabled = match skill.scope {
                SkillScope::Project | SkillScope::AgentSpecific => {
                    workspace.trusted && skill.enabled
                }
                SkillScope::User => skill.enabled,
            };
            conn.execute(
                "INSERT INTO skill_records (id, scope, name, description, location, source_dir, owner, enabled, diagnostics_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    skill.id,
                    enum_text(&skill.scope),
                    skill.name,
                    skill.description,
                    skill.location,
                    skill.source_dir,
                    enum_text(&skill.owner),
                    enabled as i64,
                    skill.diagnostics_json.to_string()
                ],
            )?;
        }
        Ok(())
    }

    pub fn list(&self) -> StorageResult<Vec<SkillRecord>> {
        let conn = self.conn;
        let mut stmt = conn.prepare(
            "SELECT id, scope, name, description, location, source_dir, owner, enabled, diagnostics_json FROM skill_records ORDER BY name",
        )?;
        let rows = stmt.query_map([], read_skill)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(crate::storage::error::StorageError::from)
    }
}
