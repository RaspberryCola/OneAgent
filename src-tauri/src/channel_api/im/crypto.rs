use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use rand::RngCore;
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
};

fn get_secret_key_path() -> PathBuf {
    let mut path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push(".oneagent");
    let _ = fs::create_dir_all(&path);
    path.push("secret.key");
    path
}

fn get_or_create_key() -> std::io::Result<[u8; 32]> {
    let key_path = get_secret_key_path();
    if key_path.exists() {
        let mut file = File::open(&key_path)?;
        let mut key = [0u8; 32];
        file.read_exact(&mut key)?;
        Ok(key)
    } else {
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        let mut file = File::create(&key_path)?;
        file.write_all(&key)?;
        Ok(key)
    }
}

pub fn encrypt(plaintext: &str) -> Result<String, String> {
    let key_bytes = get_or_create_key().map_err(|e| format!("Failed to get or create key: {}", e))?;
    let key = aes_gcm::Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("Encryption error: {:?}", e))?;
        
    // Combine nonce and ciphertext
    let mut combined = Vec::with_capacity(nonce_bytes.len() + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);
    
    Ok(BASE64_STANDARD.encode(combined))
}

pub fn decrypt(ciphertext_b64: &str) -> Result<String, String> {
    let key_bytes = get_or_create_key().map_err(|e| format!("Failed to get or create key: {}", e))?;
    let combined = BASE64_STANDARD.decode(ciphertext_b64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;
        
    if combined.len() < 12 {
        return Err("Ciphertext too short".to_string());
    }
    
    let (nonce_bytes, ciphertext_bytes) = combined.split_at(12);
    let key = aes_gcm::Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(nonce_bytes);
    
    let decrypted_bytes = cipher
        .decrypt(nonce, ciphertext_bytes)
        .map_err(|e| format!("Decryption error: {:?}", e))?;
        
    String::from_utf8(decrypted_bytes).map_err(|e| format!("Invalid UTF-8 plaintext: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt() {
        let text = "secret_credentials_12345";
        let encrypted = encrypt(text).unwrap();
        assert_ne!(text, encrypted);
        
        let decrypted = decrypt(&encrypted).unwrap();
        assert_eq!(text, decrypted);
    }
}
