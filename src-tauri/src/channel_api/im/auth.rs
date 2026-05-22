use chrono::Utc;
use rand::Rng;
use uuid::Uuid;
use crate::storage::Database;

pub struct ImAuthService;

impl ImAuthService {
    pub fn is_authorized(
        platform_user_id: &str,
        platform_type: &str,
        db: &Database,
    ) -> Result<bool, String> {
        let conn = db.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT 1 FROM im_authorized_users WHERE platform_user_id = ?1 AND platform_type = ?2",
            )
            .map_err(|e| e.to_string())?;
        
        let exists = stmt
            .exists([platform_user_id, platform_type])
            .map_err(|e| e.to_string())?;

        Ok(exists)
    }

    pub fn generate_pairing_code(
        platform_user_id: &str,
        platform_type: &str,
        display_name: Option<&str>,
        db: &Database,
    ) -> Result<String, String> {
        let code = rand::thread_rng().gen_range(100_000..1_000_000).to_string();
        let now = Utc::now().timestamp();
        let expires = now + 600; // 10 minutes from now

        let conn = db.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO im_pairing_codes (code, platform_user_id, platform_type, display_name, requested_at, expires_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
            rusqlite::params![
                code,
                platform_user_id,
                platform_type,
                display_name.unwrap_or(""),
                now,
                expires
            ],
        )
        .map_err(|e| e.to_string())?;

        Ok(code)
    }

    pub fn approve_pairing(
        code: &str,
        db: &Database,
    ) -> Result<(String, String), String> {
        let conn = db.conn.lock();
        
        // 1. Find the pending pairing code
        let mut stmt = conn
            .prepare(
                "SELECT platform_user_id, platform_type, display_name, expires_at 
                 FROM im_pairing_codes 
                 WHERE code = ?1 AND status = 'pending'",
            )
            .map_err(|e| e.to_string())?;

        let now = Utc::now().timestamp();
        
        let (platform_user_id, platform_type, display_name, expires_at) = stmt
            .query_row([code], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|_| "Pairing code not found or already processed".to_string())?;

        if now > expires_at {
            // Update status to expired
            conn.execute(
                "UPDATE im_pairing_codes SET status = 'expired' WHERE code = ?1",
                [code],
            )
            .map_err(|e| e.to_string())?;
            return Err("Pairing code has expired".to_string());
        }

        // 2. Insert into im_authorized_users
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT OR REPLACE INTO im_authorized_users (id, platform_user_id, platform_type, display_name, authorized_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, platform_user_id, platform_type, display_name, now],
        )
        .map_err(|e| e.to_string())?;

        // 3. Update pairing code to approved
        conn.execute(
            "UPDATE im_pairing_codes SET status = 'approved' WHERE code = ?1",
            [code],
        )
        .map_err(|e| e.to_string())?;

        Ok((platform_user_id, platform_type))
    }
}
