use rusqlite::{params, Connection, OptionalExtension};
use crate::storage::error::StorageResult;

pub struct SettingsRepository<'a> {
    conn: &'a Connection,
}

impl<'a> SettingsRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn get(&self, key: &str) -> StorageResult<Option<String>> {
        self.conn
            .query_row(
                "SELECT value FROM system_settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn set(&self, key: &str, value: &str) -> StorageResult<()> {
        self.conn.execute(
            "INSERT INTO system_settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::sqlite::connection::Database;

    #[test]
    fn test_settings_get_set() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock();
        let repo = SettingsRepository::new(&conn);

        // Initially setting is not present
        assert_eq!(repo.get("test_key").unwrap(), None);

        // Setting a key
        repo.set("test_key", "test_value").unwrap();
        assert_eq!(repo.get("test_key").unwrap(), Some("test_value".to_string()));

        // Updating the key
        repo.set("test_key", "new_value").unwrap();
        assert_eq!(repo.get("test_key").unwrap(), Some("new_value".to_string()));
    }
}

