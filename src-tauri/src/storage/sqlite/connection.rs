use std::{path::PathBuf, sync::Arc};

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::storage::error::StorageResult;
use crate::storage::sqlite::migrations::MigrationManager;

#[derive(Clone)]
pub struct Database {
    pub(crate) conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn open_default() -> StorageResult<Self> {
        let db_dir = dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("oneagent");
        std::fs::create_dir_all(&db_dir)?;
        let db_path = db_dir.join("oneagent.db");
        let conn = Connection::open(db_path)?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        MigrationManager::new(&db.conn).migrate()?;
        Ok(db)
    }
}
