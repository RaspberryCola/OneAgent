pub mod error;
pub mod facade;
pub mod mappers;
pub mod repositories;
pub mod sqlite;

pub use error::{StorageError, StorageResult};
pub use sqlite::connection::Database;
