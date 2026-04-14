#[derive(thiserror::Error, Debug)]
pub enum StorageError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("record not found: {0}")]
    NotFound(String),
}

pub type StorageResult<T> = Result<T, StorageError>;
