//! Native Cloud-auth command boundary. Cloud origins are selected here by the packaged host;
//! callers can never supply a base URL. Until an origin is approved and populated, commands fail
//! closed with `CLOUD_ORIGIN_NOT_CONFIGURED`.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

use crate::commands::AppState;

/// These slots are deliberately unset until the execution lead approves an account-level
/// development endpoint and a production endpoint. Do not populate from a WebView setting,
/// environment variable, command argument, or remote response.
const DEVELOPMENT_ORIGIN: Option<&str> = None;
const PRODUCTION_ORIGIN: Option<&str> = None;
/// The Cloud service currently caps blobs at 10 MiB. Native memory use is bounded to this size.
const MAX_BLOB_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CloudEnvironment {
    Development,
    Production,
}

impl CloudEnvironment {
    /// Build-time host selection only. A local/development build may opt into the development
    /// registry entry by changing this constant after that endpoint is approved.
    const SELECTED: Self = Self::Production;

    fn origin(self) -> Result<&'static str, &'static str> {
        let candidate = match self {
            Self::Development => DEVELOPMENT_ORIGIN,
            Self::Production => PRODUCTION_ORIGIN,
        }
        .ok_or("CLOUD_ORIGIN_NOT_CONFIGURED")?;

        validate_https_origin(candidate).map_err(|_| "CLOUD_ORIGIN_NOT_CONFIGURED")?;
        Ok(candidate)
    }
}

pub(crate) fn validate_https_origin(candidate: &str) -> Result<(), ()> {
    let parsed = tauri::Url::parse(candidate).map_err(|_| ())?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err(());
    }
    Ok(())
}

pub(crate) fn selected_cloud_origin() -> Result<Option<&'static str>, String> {
    match CloudEnvironment::SELECTED.origin() {
        Ok(origin) => Ok(Some(origin)),
        Err("CLOUD_ORIGIN_NOT_CONFIGURED") => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthBeginRequest {
    pub workspace_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCompleteRequest {
    pub transaction_id: String,
    pub credential: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedRequest {
    pub path: String,
    pub method: String,
    pub body: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobUploadRequest {
    pub name: String,
    pub expires_in_sec: u16,
    pub ingestion_id: String,
    /// Serialized as a byte array over the narrow native bridge; the signed destination is
    /// always obtained from the configured Cloud origin and is never caller-supplied.
    pub bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthBeginResponse {
    pub transaction_id: String,
    pub options: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct AuthenticatedResponse {
    pub status: u16,
    pub body: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobUploadResponse {
    pub object_ref_id: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    SignedOut,
    Authenticated,
    ReauthRequired,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusResponse {
    pub status: SessionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

/// Native IPC entry points. They are intentionally unavailable until an approved host is
/// configured; no operation can fall back to a caller-controlled origin.
#[tauri::command]
pub async fn cloud_auth_begin(
    state: State<'_, AppState>,
    request: AuthBeginRequest,
) -> Result<AuthBeginResponse, String> {
    let service = Arc::clone(&state.cloud_auth);
    tauri::async_runtime::spawn_blocking(move || service.begin(request))
        .await
        .map_err(|_| "CLOUD_AUTH_WORKER_FAILED".to_string())?
}

#[tauri::command]
pub async fn cloud_auth_complete(
    state: State<'_, AppState>,
    request: AuthCompleteRequest,
) -> Result<SessionStatusResponse, String> {
    let service = Arc::clone(&state.cloud_auth);
    tauri::async_runtime::spawn_blocking(move || service.complete(request))
        .await
        .map_err(|_| "CLOUD_AUTH_WORKER_FAILED".to_string())?
}

#[tauri::command]
pub async fn cloud_session_status(
    state: State<'_, AppState>,
) -> Result<SessionStatusResponse, String> {
    let service = Arc::clone(&state.cloud_auth);
    tauri::async_runtime::spawn_blocking(move || service.session_status())
        .await
        .map_err(|_| "CLOUD_AUTH_WORKER_FAILED".to_string())?
}

#[tauri::command]
pub async fn cloud_session_logout(
    state: State<'_, AppState>,
) -> Result<SessionStatusResponse, String> {
    let service = Arc::clone(&state.cloud_auth);
    tauri::async_runtime::spawn_blocking(move || service.logout())
        .await
        .map_err(|_| "CLOUD_AUTH_WORKER_FAILED".to_string())?
}

#[tauri::command]
pub async fn cloud_authenticated_request(
    state: State<'_, AppState>,
    request: AuthenticatedRequest,
) -> Result<AuthenticatedResponse, String> {
    let service = Arc::clone(&state.cloud_auth);
    tauri::async_runtime::spawn_blocking(move || service.authenticated_request(request))
        .await
        .map_err(|_| "CLOUD_AUTH_WORKER_FAILED".to_string())?
}

#[tauri::command]
pub async fn cloud_blob_upload(
    state: State<'_, AppState>,
    request: BlobUploadRequest,
) -> Result<BlobUploadResponse, String> {
    let service = Arc::clone(&state.cloud_auth);
    tauri::async_runtime::spawn_blocking(move || service.upload_blob(request))
        .await
        .map_err(|_| "CLOUD_AUTH_WORKER_FAILED".to_string())?
}

/// The push response is validated natively and forwarded directly to sidecar memory; no
/// Cloud acknowledgement or outcome is serialized back to the WebView.
#[tauri::command]
pub async fn cloud_sync_push_to_sidecar(
    state: State<'_, AppState>,
    request: serde_json::Value,
) -> Result<(), String> {
    let service = Arc::clone(&state.cloud_auth);
    let supervisor = Arc::clone(&state.supervisor);
    let port = supervisor.port();
    let token = supervisor.native_sync_token().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        service.sync_push_to_sidecar(request, port, &token)
    })
    .await
    .map_err(|_| "CLOUD_AUTH_WORKER_FAILED".to_string())?
}

pub(crate) fn validate_blob_upload(request: &BlobUploadRequest) -> Result<(), String> {
    let name = request.name.as_bytes();
    let is_name_char =
        |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-');
    if name.is_empty()
        || name.len() > 240
        || !name[0].is_ascii_alphanumeric()
        || !name.iter().copied().all(is_name_char)
    {
        return Err("BLOB_NAME_INVALID".into());
    }
    if !(30..=300).contains(&request.expires_in_sec) {
        return Err("BLOB_EXPIRY_INVALID".into());
    }
    if request.ingestion_id.is_empty() || request.ingestion_id.len() > 128 {
        return Err("BLOB_INGESTION_ID_INVALID".into());
    }
    if request.bytes.len() > MAX_BLOB_BYTES {
        return Err("BLOB_TOO_LARGE".into());
    }
    Ok(())
}

pub(crate) fn validate_authenticated_route(request: &AuthenticatedRequest) -> Result<(), String> {
    if request.path == "/v2/brain/ingestions" {
        return if request.method == "POST"
            && request.body.as_ref().is_none_or(|body| body.is_object())
        {
            Ok(())
        } else {
            Err("CLOUD_ROUTE_NOT_ALLOWED".into())
        };
    }

    let parts: Vec<_> = request.path.split('/').collect();
    if parts.len() == 5
        && parts[0].is_empty()
        && parts[1] == "v2"
        && parts[2] == "brain"
        && parts[3] == "ingestions"
        && is_canonical_uuid(parts[4])
        && request.method == "GET"
        && request.body.is_none()
    {
        return Ok(());
    }
    if parts.len() == 6
        && parts[0].is_empty()
        && parts[1] == "v2"
        && parts[2] == "brain"
        && parts[3] == "ingestions"
        && is_canonical_uuid(parts[4])
        && parts[5] == "finalize"
        && request.method == "POST"
        && request.body.as_ref().is_none_or(|body| body.is_object())
    {
        return Ok(());
    }
    if request.method == "GET" && request.path.starts_with("/v1/sync/pull?") {
        return validate_sync_pull_query(&request.path["/v1/sync/pull?".len()..]);
    }
    Err("CLOUD_ROUTE_NOT_ALLOWED".into())
}

fn validate_sync_pull_query(query: &str) -> Result<(), String> {
    use std::collections::HashSet;
    if query.is_empty() || query.len() > 4096 {
        return Err("CLOUD_QUERY_INVALID".into());
    }
    let mut seen = HashSet::new();
    let mut protocol = None;
    let mut schema = None;
    let mut cursor = None;
    let mut limit = None;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            return Err("CLOUD_QUERY_INVALID".into());
        };
        if !seen.insert(key) || value.contains(['%', '+']) {
            return Err("CLOUD_QUERY_INVALID".into());
        }
        match key {
            "protocolVersion" if value == "1" => protocol = Some(()),
            "schemaVersion" if value == "cloud-sync-v1" => schema = Some(()),
            "cursor"
                if value.len() <= 512
                    && value.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
                    }) =>
            {
                cursor = Some(())
            }
            "limit" if value.bytes().all(|byte| byte.is_ascii_digit()) => {
                let parsed = value.parse::<u16>().map_err(|_| "CLOUD_QUERY_INVALID")?;
                if !(1..=1000).contains(&parsed) {
                    return Err("CLOUD_QUERY_INVALID".into());
                }
                limit = Some(());
            }
            _ => return Err("CLOUD_QUERY_INVALID".into()),
        }
    }
    let _ = (cursor, limit);
    if protocol.is_some() && schema.is_some() {
        Ok(())
    } else {
        Err("CLOUD_QUERY_INVALID".into())
    }
}

fn is_canonical_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index)
                || byte.is_ascii_digit()
                || (b'a'..=b'f').contains(byte)
        })
        && matches!(bytes[14], b'1'..=b'8')
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

/// Accept only a relative access route returned by the pinned Cloud host. This is used when
/// completing a blob reference exchange; arbitrary hosts, query strings, and redirects are not
/// accepted.
pub(crate) fn validate_blob_access_path(path: &str) -> bool {
    let Some(token) = path.strip_prefix("/v1/blobs/access/") else {
        return false;
    };
    !token.is_empty()
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_registry_is_fail_closed_until_configured() {
        assert_eq!(selected_cloud_origin().unwrap(), None);
    }

    #[test]
    fn origin_validator_accepts_only_bare_https_origins() {
        assert!(validate_https_origin("https://cloud.example/").is_ok());
        for invalid in [
            "http://cloud.example/",
            "https://user:pass@cloud.example/",
            "https://cloud.example/path",
            "https://cloud.example/?x=1",
            "https://cloud.example/#fragment",
            "not a url",
        ] {
            assert!(
                validate_https_origin(invalid).is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[test]
    fn blob_upload_limits_and_name_pattern_are_enforced() {
        let mut request = BlobUploadRequest {
            name: "source_1.json".into(),
            expires_in_sec: 60,
            ingestion_id: "ingest-1".into(),
            bytes: vec![0; MAX_BLOB_BYTES],
        };
        assert!(validate_blob_upload(&request).is_ok());
        request.name = ".hidden".into();
        assert_eq!(
            validate_blob_upload(&request),
            Err("BLOB_NAME_INVALID".into())
        );
        request.name = "ok".into();
        request.expires_in_sec = 29;
        assert_eq!(
            validate_blob_upload(&request),
            Err("BLOB_EXPIRY_INVALID".into())
        );
        request.expires_in_sec = 60;
        request.bytes.push(0);
        assert_eq!(validate_blob_upload(&request), Err("BLOB_TOO_LARGE".into()));
    }

    #[test]
    fn blob_access_only_accepts_cloud_relative_signed_path() {
        assert!(validate_blob_access_path("/v1/blobs/access/abc_DEF-123"));
        for invalid in [
            "https://evil.example/v1/blobs/access/token",
            "//evil.example/v1/blobs/access/token",
            "/v1/blobs/access/",
            "/v1/blobs/access/token?host=evil",
            "/v1/blobs/access/token/extra",
        ] {
            assert!(!validate_blob_access_path(invalid), "accepted {invalid}");
        }
    }

    #[test]
    fn authenticated_route_and_method_are_allowlisted() {
        let create = AuthenticatedRequest {
            path: "/v2/brain/ingestions".into(),
            method: "POST".into(),
            body: None,
        };
        assert!(validate_authenticated_route(&create).is_ok());
        let mut detail = AuthenticatedRequest {
            path: "/v2/brain/ingestions/123e4567-e89b-42d3-a456-426614174000".into(),
            method: "GET".into(),
            body: None,
        };
        assert!(validate_authenticated_route(&detail).is_ok());
        detail.path.push_str("/finalize");
        detail.method = "POST".into();
        assert!(validate_authenticated_route(&detail).is_ok());
        for (path, method) in [
            ("https://evil.example/v2/brain/ingestions", "POST"),
            ("/v1/blobs/ref", "POST"),
            ("/v2/brain/ingestions?target=evil", "POST"),
            (
                "/v2/brain/ingestions/123e4567-e89b-42d3-a456-426614174000",
                "DELETE",
            ),
        ] {
            let request = AuthenticatedRequest {
                path: path.into(),
                method: method.into(),
                body: None,
            };
            assert_eq!(
                validate_authenticated_route(&request),
                Err("CLOUD_ROUTE_NOT_ALLOWED".into())
            );
        }
    }

    #[test]
    fn sync_routes_allow_only_strict_push_and_pull_fields() {
        for (path, method, body, allowed) in [
            // Push uses the private command because its acknowledgement must never return to JS.
            ("/v1/sync/push", "POST", Some(serde_json::json!({"changes":[]})), false),
            ("/v1/sync/push", "GET", None, false),
            ("/v1/sync/push?cursor=aa", "POST", Some(serde_json::json!({})), false),
            ("/v1/sync/pull?protocolVersion=1&schemaVersion=cloud-sync-v1", "GET", None, true),
            ("/v1/sync/pull?protocolVersion=1&schemaVersion=cloud-sync-v1&cursor=YWJj&limit=1000", "GET", None, true),
            ("/v1/sync/pull?protocolVersion=2&schemaVersion=cloud-sync-v1", "GET", None, false),
            ("/v1/sync/pull?protocolVersion=1&schemaVersion=cloud-sync-v1&limit=1001", "GET", None, false),
            ("/v1/sync/pull?protocolVersion=1&schemaVersion=cloud-sync-v1&cursor=x&cursor=y", "GET", None, false),
            ("/v1/sync/pull?protocolVersion=1&schemaVersion=cloud-sync-v1&host=evil", "GET", None, false),
            ("/v1/sync/pull?protocolVersion=1&schemaVersion=cloud-sync-v1%26host%3Devil", "GET", None, false),
        ] {
            let request = AuthenticatedRequest {
                path: path.into(),
                method: method.into(),
                body,
            };
            assert_eq!(validate_authenticated_route(&request).is_ok(), allowed, "{method} {path}");
        }
    }
}
