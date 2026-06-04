use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use sha2::{Digest, Sha256};

/// Encryption key derived from machine-specific data.
/// In production, this should use a proper key management system.
static mut ENCRYPTION_KEY: Option<[u8; 32]> = None;

/// Initialize the encryption key from machine-specific data.
/// This should be called once at startup.
pub fn init_encryption_key() {
    // In production, derive key from machine-specific data
    // For now, use a simple hash of hostname + username
    let mut hasher = Sha256::new();
    
    if let Ok(hostname) = hostname::get() {
        hasher.update(hostname.to_string_lossy().as_bytes());
    }
    
    if let Some(username) = dirs::home_dir() {
        hasher.update(username.to_string_lossy().as_bytes());
    }
    
    hasher.update(b"oneagent-encryption-salt");
    
    let hash = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&hash);
    
    unsafe {
        ENCRYPTION_KEY = Some(key);
    }
}

/// Get the encryption key.
fn get_encryption_key() -> Result<[u8; 32], String> {
    unsafe {
        ENCRYPTION_KEY.ok_or_else(|| "Encryption key not initialized".to_string())
    }
}

/// Encrypt a string value using AES-256-GCM.
/// Returns a base64-encoded string containing nonce + ciphertext.
pub fn encrypt_value(plaintext: &str) -> Result<String, String> {
    let key = get_encryption_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("Failed to create cipher: {e}"))?;
    
    // Generate a random 96-bit nonce
    let nonce_bytes: [u8; 12] = rand::random();
    let nonce = Nonce::from_slice(&nonce_bytes);
    
    // Encrypt the plaintext
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("Encryption failed: {e}"))?;
    
    // Combine nonce + ciphertext and encode as base64
    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);
    
    Ok(BASE64.encode(combined))
}

/// Decrypt a base64-encoded encrypted value.
/// Expects input format: base64(nonce + ciphertext)
pub fn decrypt_value(encrypted: &str) -> Result<String, String> {
    let key = get_encryption_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("Failed to create cipher: {e}"))?;
    
    // Decode from base64
    let combined = BASE64
        .decode(encrypted)
        .map_err(|e| format!("Base64 decode failed: {e}"))?;
    
    // Split nonce and ciphertext
    if combined.len() < 12 {
        return Err("Invalid encrypted data: too short".to_string());
    }
    
    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    
    // Decrypt
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("Decryption failed: {e}"))?;
    
    String::from_utf8(plaintext)
        .map_err(|e| format!("Invalid UTF-8 in decrypted data: {e}"))
}

/// Check if a value appears to be encrypted (base64-encoded with valid length).
pub fn is_encrypted(value: &str) -> bool {
    if let Ok(decoded) = BASE64.decode(value) {
        // Minimum size: 12 bytes nonce + 16 bytes tag + at least 1 byte data
        decoded.len() >= 29
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_encrypt_decrypt() {
        init_encryption_key();
        
        let plaintext = "test-api-key-12345";
        let encrypted = encrypt_value(plaintext).unwrap();
        
        assert!(is_encrypted(&encrypted));
        
        let decrypted = decrypt_value(&encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }
    
    #[test]
    fn test_different_ciphertexts() {
        init_encryption_key();
        
        let plaintext = "same-plaintext";
        let encrypted1 = encrypt_value(plaintext).unwrap();
        let encrypted2 = encrypt_value(plaintext).unwrap();
        
        // Different nonces should produce different ciphertexts
        assert_ne!(encrypted1, encrypted2);
        
        // But both should decrypt to the same plaintext
        assert_eq!(decrypt_value(&encrypted1).unwrap(), plaintext);
        assert_eq!(decrypt_value(&encrypted2).unwrap(), plaintext);
    }
    
    #[test]
    fn test_is_encrypted() {
        init_encryption_key();
        
        let encrypted = encrypt_value("test").unwrap();
        assert!(is_encrypted(&encrypted));
        
        assert!(!is_encrypted("not-encrypted"));
        assert!(!is_encrypted(""));
    }
}
