use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};
use tracing::info;

use super::ws::WebState;

/// Percent-decode a URL-encoded string. JWT tokens use base64url which
/// normally doesn't require encoding, but the frontend applies
/// `encodeURIComponent` which may encode characters like `=`, `+`, `/`.
fn percent_decode(input: &str) -> String {
    let mut result = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                &input[i + 1..i + 3],
                16,
            ) {
                result.push(byte);
                i += 3;
                continue;
            }
        } else if bytes[i] == b'+' {
            result.push(b' ');
            i += 1;
            continue;
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&result).into_owned()
}

pub async fn auth_middleware(
    State(state): State<WebState>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let path = req.uri().path().to_string();

    // 1. Try Authorization header
    let auth_token = req.headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer ").or_else(|| s.strip_prefix("bearer ")))
        .map(|s| s.to_string());

    // 2. Try Cookie
    let cookie_token = req.headers()
        .get("cookie")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| {
            s.split(';')
                .map(|c| c.trim())
                .find(|c| c.starts_with("token="))
                .map(|c| c[6..].to_string())
        });

    // 3. Try query parameter (?token=...) — with URL-decoding
    let query_token = req.uri().query().and_then(|q| {
        q.split('&')
            .filter_map(|pair| {
                let mut parts = pair.splitn(2, '=');
                let key = parts.next()?;
                let val = parts.next().unwrap_or("");
                if key == "token" { Some(percent_decode(val)) } else { None }
            })
            .next()
    });

    // Log origin info for diagnostics
    let origin = req.headers()
        .get("origin")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("(none)");
    let host = req.headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("(none)");

    // Try each token source in order
    for (source, token) in [
        ("header", auth_token),
        ("cookie", cookie_token),
        ("query", query_token),
    ] {
        if let Some(ref token) = token {
            let prefix = &token[..token.len().min(20)];
            info!(
                "Auth: trying {} token (len={}, prefix={}) for {} [host={}, origin={}]",
                source, token.len(), prefix, path, host, origin
            );
            match state.auth.verify_jwt(token) {
                Ok(_) => return Ok(next.run(req).await),
                Err(e) => {
                    info!("Auth: {} token FAILED for {}: {} (error_kind={:?})", source, path, e, e.kind());
                }
            }
        }
    }

    info!("Auth: all token sources failed for {} [host={}, origin={}]", path, host, origin);
    Err(StatusCode::UNAUTHORIZED)
}
