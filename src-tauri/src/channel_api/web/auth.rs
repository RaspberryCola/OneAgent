use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use rand::{Rng, thread_rng};
use rand::distributions::Alphanumeric;
use jsonwebtoken::{encode, decode, Header, Validation, EncodingKey, DecodingKey};
use chrono::{Utc, Duration};
use tracing;

#[derive(Serialize, Deserialize, Clone)]
struct AuthConfig {
    pub password_hash: String,
    pub salt: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub jwt_secret: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: i64,
}

#[derive(Clone)]
pub struct AuthService {
    jwt_secret: Vec<u8>,
    config_path: PathBuf,
}

impl AuthService {
    pub fn new() -> Self {
        // Use system config directory for auth configuration
        let config_dir = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("oneagent")
            .join("config");
        if !config_dir.exists() {
            let _ = fs::create_dir_all(&config_dir);
        }
        let config_path = config_dir.join("web_auth.json");

        // Migrate from legacy location if needed
        Self::migrate_from_legacy_if_needed(&config_path);

        // Ensure config exists and has a persisted jwt_secret
        Self::ensure_initialized_at(&config_path);
        let jwt_secret = Self::load_or_create_secret(&config_path);
        tracing::info!("Auth: new() loaded secret (len={}) from {:?}", jwt_secret.len(), config_path);

        Self {
            jwt_secret,
            config_path,
        }
    }

    /// Migrate auth config from legacy location (~/.oneagent/web_auth.json) to new location
    fn migrate_from_legacy_if_needed(new_path: &PathBuf) {
        if new_path.exists() {
            return; // New location already has config
        }

        let old_path = dirs::home_dir()
            .map(|h| h.join(".oneagent").join("web_auth.json"))
            .filter(|p| p.exists());

        if let Some(old) = old_path {
            tracing::info!("Migrating auth config from {:?} to {:?}", old, new_path);
            if let Ok(content) = fs::read_to_string(&old) {
                if let Err(e) = fs::write(new_path, &content) {
                    tracing::warn!("Failed to migrate auth config: {}", e);
                    return;
                }
                tracing::info!("Auth config migration completed successfully");
            }
        }
    }

    pub fn ensure_initialized_at(config_path: &PathBuf) -> Option<String> {
        if config_path.exists() {
            return None;
        }

        let raw_password: String = thread_rng()
            .sample_iter(&Alphanumeric)
            .take(16)
            .map(char::from)
            .collect();

        let salt: String = thread_rng()
            .sample_iter(&Alphanumeric)
            .take(16)
            .map(char::from)
            .collect();

        let jwt_secret: String = thread_rng()
            .sample_iter(&Alphanumeric)
            .take(64)
            .map(char::from)
            .collect();

        let password_hash = Self::hash_password_static(&raw_password, &salt);

        let config = AuthConfig {
            password_hash,
            salt,
            password: Some(raw_password.clone()),
            jwt_secret: Some(jwt_secret),
        };

        if let Ok(content) = serde_json::to_string_pretty(&config) {
            let _ = fs::write(config_path, content);
        }

        Some(raw_password)
    }

    /// Load persisted jwt_secret, or create and persist one if missing (migration).
    fn load_or_create_secret(config_path: &PathBuf) -> Vec<u8> {
        if let Ok(content) = fs::read_to_string(config_path) {
            if let Ok(mut config) = serde_json::from_str::<AuthConfig>(&content) {
                if let Some(ref secret) = config.jwt_secret {
                    return secret.as_bytes().to_vec();
                }
                // Migration: add jwt_secret to existing config
                let secret: String = thread_rng()
                    .sample_iter(&Alphanumeric)
                    .take(64)
                    .map(char::from)
                    .collect();
                config.jwt_secret = Some(secret.clone());
                if let Ok(new_content) = serde_json::to_string_pretty(&config) {
                    let _ = fs::write(config_path, new_content);
                }
                return secret.as_bytes().to_vec();
            }
        }
        // Fallback: generate in-memory only
        let mut secret = vec![0u8; 32];
        thread_rng().fill(&mut secret[..]);
        secret
    }

    /// Create a JWT token using the same AuthService initialization as the web server.
    pub fn create_token(config_path: &PathBuf) -> Option<String> {
        Self::ensure_initialized_at(config_path);
        let service = Self::new_with_path(config_path.clone());
        let token = service.create_jwt().ok();
        if let Some(ref t) = token {
            tracing::info!("Auth: create_token secret_len={} token_prefix={}", service.jwt_secret.len(), &t[..t.len().min(30)]);
        }
        token
    }

    fn new_with_path(config_path: PathBuf) -> Self {
        let jwt_secret = Self::load_or_create_secret(&config_path);
        Self { jwt_secret, config_path }
    }

    /// Read the stored plaintext password from the config file.
    pub fn get_password_at(config_path: &PathBuf) -> Option<String> {
        let content = fs::read_to_string(config_path).ok()?;
        let config: AuthConfig = serde_json::from_str(&content).ok()?;
        config.password
    }

    fn hash_password_static(password: &str, salt: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(password.as_bytes());
        hasher.update(salt.as_bytes());
        let result = hasher.finalize();
        result.iter().map(|b| format!("{:02x}", b)).collect()
    }

    fn get_config(&self) -> Option<AuthConfig> {
        let content = fs::read_to_string(&self.config_path).ok()?;
        serde_json::from_str(&content).ok()
    }

    pub fn verify_password(&self, password: &str) -> bool {
        if let Some(config) = self.get_config() {
            let hash = Self::hash_password_static(password, &config.salt);
            hash == config.password_hash
        } else {
            false
        }
    }

    pub fn change_password(&self, current_password: &str, new_password: &str) -> Result<(), &'static str> {
        if !self.verify_password(current_password) {
            return Err("Incorrect current password");
        }

        let salt: String = thread_rng()
            .sample_iter(&Alphanumeric)
            .take(16)
            .map(char::from)
            .collect();

        let password_hash = Self::hash_password_static(new_password, &salt);
        let mut config = self.get_config().ok_or("Failed to read config")?;
        config.password_hash = password_hash;
        config.salt = salt;
        config.password = Some(new_password.to_string());

        let content = serde_json::to_string_pretty(&config).map_err(|_| "Failed to serialize config")?;
        fs::write(&self.config_path, content).map_err(|_| "Failed to write config file")?;
        Ok(())
    }

    pub fn create_jwt(&self) -> Result<String, jsonwebtoken::errors::Error> {
        let expiration = Utc::now()
            .checked_add_signed(Duration::days(7))
            .expect("valid timestamp")
            .timestamp();

        let claims = Claims {
            sub: "user".to_owned(),
            exp: expiration,
        };

        let header = Header::default();
        let key = EncodingKey::from_secret(&self.jwt_secret);
        let token = encode(&header, &claims, &key)?;

        let secret_hex = self.jwt_secret.iter().take(8).map(|b| format!("{:02x}", b)).collect::<String>();
        tracing::info!(
            "Auth: create_jwt secret_len={} secret_hex={} token_len={} token_prefix={}",
            self.jwt_secret.len(), secret_hex, token.len(), &token[..token.len().min(30)]
        );
        Ok(token)
    }

    pub fn verify_jwt(&self, token: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
        let secret_hex = self.jwt_secret.iter().take(8).map(|b| format!("{:02x}", b)).collect::<String>();
        let token_prefix = &token[..token.len().min(30)];
        tracing::info!(
            "Auth: verify_jwt secret_len={} secret_hex={} token_len={} token_prefix={}",
            self.jwt_secret.len(), secret_hex, token.len(), token_prefix
        );
        let key = DecodingKey::from_secret(&self.jwt_secret);
        let mut validation = Validation::default();
        // Relax validation: only require exp, don't check iss/aud/sub
        validation.required_spec_claims.clear();
        validation.required_spec_claims.insert("exp".to_string());
        let token_data = decode::<Claims>(token, &key, &validation)?;
        Ok(token_data.claims)
    }
}
