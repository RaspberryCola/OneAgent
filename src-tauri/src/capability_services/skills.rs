use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::json;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::{
    domain::{SkillOwner, SkillRecord, SkillScope, Workspace},
    storage::{Database, StorageResult},
};

#[derive(Clone)]
pub struct SkillRegistry {
    db: Database,
}

impl SkillRegistry {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    pub fn refresh_workspace_skills(&self, workspace: &Workspace) -> StorageResult<Vec<SkillRecord>> {
        let mut skills = Vec::new();
        skills.extend(scan_common_dir(
            &PathBuf::from(&workspace.cwd).join(".agents/skills"),
            SkillScope::Project,
            SkillOwner::AgentCommon,
        ));
        skills.extend(scan_common_dir(
            &PathBuf::from(&workspace.cwd).join(".oneagent/skills"),
            SkillScope::Project,
            SkillOwner::Other,
        ));
        skills.extend(scan_common_dir(
            &PathBuf::from(&workspace.cwd).join(".opencode/skills"),
            SkillScope::AgentSpecific,
            SkillOwner::Opencode,
        ));
        if let Some(home) = dirs::home_dir() {
            skills.extend(scan_common_dir(
                &home.join(".agents/skills"),
                SkillScope::User,
                SkillOwner::AgentCommon,
            ));
            skills.extend(scan_common_dir(
                &home.join(".oneagent/skills"),
                SkillScope::User,
                SkillOwner::Other,
            ));
        }
        self.db.replace_workspace_skills(workspace, &skills)?;
        self.db.list_skills()
    }
}

fn scan_common_dir(base: &Path, scope: SkillScope, owner: SkillOwner) -> Vec<SkillRecord> {
    if !base.exists() {
        return Vec::new();
    }
    WalkDir::new(base)
        .min_depth(1)
        .max_depth(2)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_dir())
        .filter_map(|entry| {
            let skill_md = entry.path().join("SKILL.md");
            if !skill_md.exists() {
                return None;
            }
            Some(build_skill_record(&skill_md, scope.clone(), owner.clone()))
        })
        .collect()
}

fn build_skill_record(path: &Path, scope: SkillScope, owner: SkillOwner) -> SkillRecord {
    let raw = fs::read_to_string(path).unwrap_or_default();
    let mut lines = raw.lines();
    let title = lines
        .next()
        .map(|line| line.trim_start_matches('#').trim().to_string())
        .filter(|line| !line.is_empty())
        .unwrap_or_else(|| {
            path.parent()
                .and_then(|p| p.file_name())
                .map(|v| v.to_string_lossy().to_string())
                .unwrap_or_else(|| "Unnamed Skill".to_string())
        });
    let description = lines
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
        .unwrap_or_else(|| "No description".to_string());
    SkillRecord {
        id: Uuid::new_v4().to_string(),
        scope,
        name: title,
        description,
        location: path.to_string_lossy().to_string(),
        source_dir: path
            .parent()
            .unwrap_or(path)
            .to_string_lossy()
            .to_string(),
        owner,
        enabled: true,
        diagnostics_json: json!({
            "exists": true,
            "size_bytes": raw.len()
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

    use super::scan_common_dir;
    use crate::domain::{SkillOwner, SkillScope};

    #[test]
    fn scan_common_dir_finds_skill_md() {
        let uniq = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("oneagent-skill-test-{uniq}"));
        let skill_dir = root.join("demo-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "# Demo Skill\nA test skill.\n").unwrap();

        let skills = scan_common_dir(&root, SkillScope::Project, SkillOwner::AgentCommon);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "Demo Skill");
        assert_eq!(skills[0].description, "A test skill.");

        let _ = fs::remove_dir_all(root);
    }
}
