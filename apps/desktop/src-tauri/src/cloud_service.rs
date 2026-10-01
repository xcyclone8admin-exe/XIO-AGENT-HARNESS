//! Native Cloud auth/session client. All network URLs come from the compiled origin registry;
//! `HttpTransport` is injectable so authentication and refresh behavior can be tested without a
//! live Worker or any environment-configurable host.

use std::collections::HashMap;
use std::io::Read;
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::digest::{digest, SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cloud_auth::{
    validate_authenticated_route, validate_blob_access_path, validate_blob_upload,
    AuthBeginRequest, AuthBeginResponse, AuthCompleteRequest, AuthenticatedRequest,
    AuthenticatedResponse, BlobUploadRequest, BlobUploadResponse, SessionStatus,
    SessionStatusResponse,
};
use crate::cloud_crypto::{
    CredentialStore, DeviceKey, SessionTokens, StoredSessionStatus, WindowsCredentialStore,
};

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES: usize = 256 * 1024;
const REFRESH_SKEW_MS: u64 = 60_000;
const AUTH_TTL_MS: u64 = 10 * 60_000;
const MAX_SYNC_PUSH_BYTES: usize = 1_000_000;

#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub trait HttpTransport: Send + Sync {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, String>;
}

pub trait SidecarTransport: Send + Sync {
    fn record_cloud_push(&self, port: u16, token: &str, envelope: &Value) -> Result<(), String>;
}

pub struct ReqwestTransport {
    client: reqwest::blocking::Client,
}

pub struct ReqwestSidecarTransport {
    client: reqwest::blocking::Client,
}

impl ReqwestSidecarTransport {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|_| "LOCAL_SERVICE_UNAVAILABLE")?;
        Ok(Self { client })
    }
}

impl SidecarTransport for ReqwestSidecarTransport {
    fn record_cloud_push(&self, port: u16, token: &str, envelope: &Value) -> Result<(), String> {
        if port == 0 || token.len() != 43 || !token.bytes().all(is_base64url_byte) {
            return Err("LOCAL_SERVICE_UNAVAILABLE".into());
        }
        let response = self
            .client
            .post(format!(
                "http://127.0.0.1:{port}/internal/native/cloud-sync/push"
            ))
            .header("x-xyra-native-sync-token", token)
            .json(envelope)
            .send()
            .map_err(|_| "LOCAL_SERVICE_UNAVAILABLE")?;
        if response.status() != reqwest::StatusCode::OK {
            return Err("CLOUD_SYNC_ACK_RECORD_FAILED".into());
        }
        let mut bytes = Vec::new();
        response
            .take(129)
            .read_to_end(&mut bytes)
            .map_err(|_| "CLOUD_SYNC_ACK_RECORD_FAILED")?;
        if bytes.len() > 128 {
            return Err("CLOUD_SYNC_ACK_RECORD_FAILED".into());
        }
        let body: Value =
            serde_json::from_slice(&bytes).map_err(|_| "CLOUD_SYNC_ACK_RECORD_FAILED")?;
        if body.as_object().is_some_and(|object| object.len() == 1) && body["status"] == "recorded"
        {
            Ok(())
        } else {
            Err("CLOUD_SYNC_ACK_RECORD_FAILED".into())
        }
    }
}

impl ReqwestTransport {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|_| "CLOUD_HTTP_UNAVAILABLE")?;
        Ok(Self { client })
    }
}

impl HttpTransport for ReqwestTransport {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| "CLOUD_HTTP_REQUEST_INVALID")?;
        let mut builder = self.client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if !request.body.is_empty() {
            builder = builder.body(request.body);
        }
        let mut response = builder.send().map_err(|_| "CLOUD_NETWORK_UNAVAILABLE")?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_ascii_lowercase(), value.to_owned()))
            })
            .collect();
        let mut body = Vec::new();
        response
            .by_ref()
            .take((MAX_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|_| "CLOUD_RESPONSE_READ_FAILED")?;
        if body.len() > MAX_RESPONSE_BYTES {
            return Err("CLOUD_RESPONSE_TOO_LARGE".into());
        }
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingAuth {
    transaction_id: String,
    state: String,
    nonce: String,
    verifier: String,
    redirect_uri: String,
    created_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeginResponse {
    transaction_id: String,
    state: String,
    nonce: String,
    options: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    token_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobRefResponse {
    url: String,
    object_ref_id: String,
    expires_at_ms: u64,
    mode: String,
    #[serde(default)]
    key: Option<String>,
}

pub struct CloudAuthService {
    origin: Option<String>,
    transport: Arc<dyn HttpTransport>,
    sidecar_transport: Arc<dyn SidecarTransport>,
    device_key: DeviceKey,
    callback_listeners: Mutex<HashMap<String, TcpListener>>,
}

impl CloudAuthService {
    fn build(
        origin: Option<String>,
        transport: Arc<dyn HttpTransport>,
        sidecar_transport: Arc<dyn SidecarTransport>,
        store: Arc<dyn CredentialStore>,
    ) -> Result<Self, String> {
        if let Some(origin) = origin.as_deref() {
            crate::cloud_auth::validate_https_origin(origin)
                .map_err(|_| "CLOUD_ORIGIN_NOT_CONFIGURED")?;
        }
        Ok(Self {
            origin,
            transport,
            sidecar_transport,
            device_key: DeviceKey::new(store),
            callback_listeners: Mutex::new(HashMap::new()),
        })
    }

    pub fn production() -> Result<Self, String> {
        let origin = crate::cloud_auth::selected_cloud_origin()?.map(str::to_owned);
        Self::build(
            origin,
            Arc::new(ReqwestTransport::new()?),
            Arc::new(ReqwestSidecarTransport::new()?),
            Arc::new(WindowsCredentialStore),
        )
    }

    #[cfg(test)]
    fn for_test(
        origin: Option<String>,
        transport: Arc<dyn HttpTransport>,
        sidecar_transport: Arc<dyn SidecarTransport>,
        store: Arc<dyn CredentialStore>,
    ) -> Result<Self, String> {
        Self::build(origin, transport, sidecar_transport, store)
    }

    fn origin(&self) -> Result<&str, String> {
        self.origin
            .as_deref()
            .ok_or_else(|| "CLOUD_ORIGIN_NOT_CONFIGURED".into())
    }

    fn url(&self, path: &str) -> Result<String, String> {
        if !path.starts_with('/') || path.starts_with("//") || path.contains('#') {
            return Err("CLOUD_ROUTE_NOT_ALLOWED".into());
        }
        Ok(format!("{}{path}", self.origin()?))
    }

    fn send_json(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        mut headers: Vec<(String, String)>,
    ) -> Result<HttpResponse, String> {
        let body = match body {
            Some(value) => serde_json::to_vec(value).map_err(|_| "CLOUD_REQUEST_ENCODE_FAILED")?,
            None => Vec::new(),
        };
        if !body.is_empty() {
            headers.push(("content-type".into(), "application/json".into()));
        }
        self.transport.send(HttpRequest {
            method: method.into(),
            url: self.url(path)?,
            headers,
            body,
        })
    }

    fn now_ms() -> Result<u64, String> {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .map_err(|_| "CLOUD_CLOCK_INVALID".into())
    }

    fn now_seconds() -> Result<u64, String> {
        Ok(Self::now_ms()? / 1000)
    }

    fn random_token(bytes: usize) -> Result<String, String> {
        let mut random = vec![0; bytes];
        SystemRandom::new()
            .fill(&mut random)
            .map_err(|_| "CLOUD_RANDOM_UNAVAILABLE")?;
        Ok(URL_SAFE_NO_PAD.encode(random))
    }

    fn callback_listener() -> Result<(TcpListener, String), String> {
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "CLOUD_LOOPBACK_UNAVAILABLE")?;
        let port = listener
            .local_addr()
            .map_err(|_| "CLOUD_LOOPBACK_UNAVAILABLE")?
            .port();
        Ok((listener, format!("http://127.0.0.1:{port}")))
    }

    fn callback_reservation(&self, pending: &PendingAuth) -> Result<TcpListener, String> {
        let listeners = self
            .callback_listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let listener = listeners
            .get(&pending.transaction_id)
            .ok_or("CLOUD_AUTH_CALLBACK_LISTENER_MISSING")?
            .try_clone()
            .map_err(|_| "CLOUD_LOOPBACK_UNAVAILABLE")?;
        let address = listener
            .local_addr()
            .map_err(|_| "CLOUD_LOOPBACK_UNAVAILABLE")?;
        let expected =
            tauri::Url::parse(&pending.redirect_uri).map_err(|_| "CLOUD_CALLBACK_INVALID")?;
        if !address.ip().is_loopback()
            || expected.scheme() != "http"
            || expected.host_str() != Some("127.0.0.1")
            || expected.port() != Some(address.port())
            || expected.username() != ""
            || expected.password().is_some()
            || expected.query().is_some()
            || expected.fragment().is_some()
        {
            return Err("CLOUD_CALLBACK_INVALID".into());
        }
        Ok(listener)
    }

    fn json_body(response: &HttpResponse, expected_status: u16) -> Result<Value, String> {
        if response.status != expected_status {
            return Err(format!("CLOUD_HTTP_STATUS_{}", response.status));
        }
        serde_json::from_slice(&response.body).map_err(|_| "CLOUD_RESPONSE_INVALID".into())
    }

    fn header<'a>(response: &'a HttpResponse, name: &str) -> Option<&'a str> {
        response
            .headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn begin(&self, request: AuthBeginRequest) -> Result<AuthBeginResponse, String> {
        self.origin()?;
        if request.workspace_id.is_empty() || request.workspace_id.len() > 128 {
            return Err("CLOUD_WORKSPACE_ID_INVALID".into());
        }
        let identity = self.device_key.public_identity()?;
        let verifier = Self::random_token(32)?;
        let challenge = URL_SAFE_NO_PAD.encode(digest(&SHA256, verifier.as_bytes()).as_ref());
        let (callback_listener, redirect_uri) = Self::callback_listener()?;
        let body = serde_json::json!({
            "pkceChallenge": challenge,
            "redirectUri": redirect_uri,
            "deviceId": identity.device_id,
            "workspaceId": request.workspace_id,
            "deviceJwk": identity.public_jwk,
        });
        let response = self.send_json("POST", "/v1/auth/passkey/begin", Some(&body), Vec::new())?;
        let value = Self::json_body(&response, 200)?;
        let begin: BeginResponse =
            serde_json::from_value(value).map_err(|_| "CLOUD_RESPONSE_INVALID")?;
        if begin.transaction_id.is_empty()
            || begin.transaction_id.len() > 128
            || begin.state.is_empty()
            || begin.nonce.is_empty()
            || !begin.options.is_object()
        {
            return Err("CLOUD_RESPONSE_INVALID".into());
        }
        let now_ms = Self::now_ms()?;
        self.device_key.save_pending_auth(&PendingAuth {
            transaction_id: begin.transaction_id.clone(),
            state: begin.state,
            nonce: begin.nonce,
            verifier,
            redirect_uri,
            created_at_ms: now_ms,
        })?;
        let mut listeners = self
            .callback_listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        listeners.clear();
        listeners.insert(begin.transaction_id.clone(), callback_listener);
        Ok(AuthBeginResponse {
            transaction_id: begin.transaction_id,
            options: begin.options,
        })
    }

    pub fn complete(&self, request: AuthCompleteRequest) -> Result<SessionStatusResponse, String> {
        self.origin()?;
        if serde_json::to_vec(&request.credential)
            .map_err(|_| "CLOUD_CREDENTIAL_INVALID")?
            .len()
            > MAX_CREDENTIAL_BYTES
        {
            return Err("CLOUD_CREDENTIAL_TOO_LARGE".into());
        }
        let pending: PendingAuth = self
            .device_key
            .load_pending_auth()?
            .ok_or("CLOUD_AUTH_TRANSACTION_MISSING")?;
        if pending.transaction_id != request.transaction_id
            || Self::now_ms()?.saturating_sub(pending.created_at_ms) > AUTH_TTL_MS
        {
            self.device_key.clear_pending_auth()?;
            self.callback_listeners
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&pending.transaction_id);
            return Err("CLOUD_AUTH_TRANSACTION_INVALID".into());
        }
        // Clone and retain the OS-bound listener until callback URL and state validation finish.
        let _callback_reservation = self.callback_reservation(&pending)?;

        let complete_body = serde_json::json!({
            "transactionId": pending.transaction_id,
            "state": pending.state,
            "credential": request.credential,
        });
        let complete = self.send_json(
            "POST",
            "/v1/auth/passkey/complete",
            Some(&complete_body),
            Vec::new(),
        )?;
        if complete.status != 303 {
            return Err(format!("CLOUD_HTTP_STATUS_{}", complete.status));
        }
        let location = Self::header(&complete, "location").ok_or("CLOUD_CALLBACK_INVALID")?;
        let code = extract_callback_code(location, &pending)?;

        let token_url = self.url("/v1/auth/token")?;
        let proof =
            self.device_key
                .dpop_proof("POST", &token_url, Some(&code), Self::now_seconds()?)?;
        let token_body = serde_json::json!({
            "transactionId": pending.transaction_id,
            "code": code,
            "verifier": pending.verifier,
        });
        let response = self.send_json(
            "POST",
            "/v1/auth/token",
            Some(&token_body),
            vec![("dpop".into(), proof)],
        )?;
        let session = parse_token_response(&response)?;
        self.device_key.store_session(&session)?;
        self.device_key.clear_pending_auth()?;
        self.callback_listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&pending.transaction_id);
        Ok(SessionStatusResponse {
            status: SessionStatus::Authenticated,
            expires_at: Some(session.expires_at_ms),
        })
    }

    pub fn session_status(&self) -> Result<SessionStatusResponse, String> {
        match self.device_key.stored_session_status()? {
            StoredSessionStatus::SignedOut => Ok(SessionStatusResponse {
                status: SessionStatus::SignedOut,
                expires_at: None,
            }),
            StoredSessionStatus::ReauthRequired => Ok(SessionStatusResponse {
                status: SessionStatus::ReauthRequired,
                expires_at: None,
            }),
            StoredSessionStatus::Authenticated { expires_at_ms } => {
                if self.origin.is_some()
                    && expires_at_ms <= Self::now_ms()?.saturating_add(REFRESH_SKEW_MS)
                {
                    match self.ensure_session() {
                        Ok(session) => Ok(SessionStatusResponse {
                            status: SessionStatus::Authenticated,
                            expires_at: Some(session.expires_at_ms),
                        }),
                        Err(error) if error == "CLOUD_REAUTH_REQUIRED" => {
                            Ok(SessionStatusResponse {
                                status: SessionStatus::ReauthRequired,
                                expires_at: None,
                            })
                        }
                        Err(error) => Err(error),
                    }
                } else if expires_at_ms <= Self::now_ms()? {
                    Ok(SessionStatusResponse {
                        status: SessionStatus::ReauthRequired,
                        expires_at: None,
                    })
                } else {
                    Ok(SessionStatusResponse {
                        status: SessionStatus::Authenticated,
                        expires_at: Some(expires_at_ms),
                    })
                }
            }
        }
    }

    pub fn logout(&self) -> Result<SessionStatusResponse, String> {
        if self.origin.is_some() {
            if let Ok(Some(session)) = self.device_key.load_session() {
                let url = self.url("/v1/auth/logout")?;
                if let Ok(proof) = self.device_key.dpop_proof(
                    "POST",
                    &url,
                    Some(&session.access_token),
                    Self::now_seconds()?,
                ) {
                    let _ = self.send_json(
                        "POST",
                        "/v1/auth/logout",
                        Some(&serde_json::json!({})),
                        vec![
                            (
                                "authorization".into(),
                                format!("Bearer {}", session.access_token),
                            ),
                            ("dpop".into(), proof),
                        ],
                    );
                }
            }
        }
        self.device_key.clear_session()?;
        self.device_key.clear_pending_auth()?;
        self.callback_listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        Ok(SessionStatusResponse {
            status: SessionStatus::SignedOut,
            expires_at: None,
        })
    }

    pub fn authenticated_request(
        &self,
        request: AuthenticatedRequest,
    ) -> Result<AuthenticatedResponse, String> {
        self.origin()?;
        validate_authenticated_route(&request)?;
        if request.path == "/v1/sync/push" {
            return Err("CLOUD_SYNC_PRIVATE_ROUTE".into());
        }
        self.perform_authenticated_request(request)
    }

    pub fn sync_push_to_sidecar(
        &self,
        request: Value,
        sidecar_port: u16,
        native_sync_token: &str,
    ) -> Result<(), String> {
        self.origin()?;
        validate_sync_push_request(&request)?;
        if sidecar_port == 0
            || native_sync_token.len() != 43
            || !native_sync_token.bytes().all(is_base64url_byte)
        {
            return Err("LOCAL_SERVICE_UNAVAILABLE".into());
        }
        let response = self.perform_authenticated_request(AuthenticatedRequest {
            path: "/v1/sync/push".into(),
            method: "POST".into(),
            body: Some(request.clone()),
        })?;
        if response.status != 200 {
            return Err(format!("CLOUD_HTTP_STATUS_{}", response.status));
        }
        validate_sync_push_response(&request, &response.body)?;
        self.sidecar_transport.record_cloud_push(
            sidecar_port,
            native_sync_token,
            &serde_json::json!({"request": request, "response": response.body}),
        )
    }

    fn perform_authenticated_request(
        &self,
        request: AuthenticatedRequest,
    ) -> Result<AuthenticatedResponse, String> {
        let session = self.ensure_session()?;
        let url = self.url(&request.path)?;
        let proof = self.device_key.dpop_proof(
            &request.method,
            &url,
            Some(&session.access_token),
            Self::now_seconds()?,
        )?;
        let headers = vec![
            (
                "authorization".into(),
                format!("Bearer {}", session.access_token),
            ),
            ("dpop".into(), proof),
        ];
        let response = self.send_json(
            &request.method,
            &request.path,
            request.body.as_ref(),
            headers,
        )?;
        let body = if response.body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&response.body).map_err(|_| "CLOUD_RESPONSE_INVALID")?
        };
        Ok(AuthenticatedResponse {
            status: response.status,
            body,
        })
    }

    pub fn upload_blob(&self, request: BlobUploadRequest) -> Result<BlobUploadResponse, String> {
        self.origin()?;
        validate_blob_upload(&request)?;
        let session = self.ensure_session()?;
        let ref_url = self.url("/v1/blobs/ref")?;
        let proof = self.device_key.dpop_proof(
            "POST",
            &ref_url,
            Some(&session.access_token),
            Self::now_seconds()?,
        )?;
        let body = serde_json::json!({
            "mode": "PUT",
            "name": request.name,
            "expiresInSec": request.expires_in_sec,
            "ingestionId": request.ingestion_id,
        });
        let response = self.send_json(
            "POST",
            "/v1/blobs/ref",
            Some(&body),
            vec![
                (
                    "authorization".into(),
                    format!("Bearer {}", session.access_token),
                ),
                ("dpop".into(), proof),
            ],
        )?;
        let ref_value = Self::json_body(&response, 200)?;
        let reference: BlobRefResponse =
            serde_json::from_value(ref_value).map_err(|_| "CLOUD_BLOB_REFERENCE_INVALID")?;
        if reference.mode != "PUT" || !validate_blob_access_path(&reference.url) {
            return Err("CLOUD_BLOB_REFERENCE_INVALID".into());
        }
        let path = reference.url;
        let upload_url = self.url(&path)?;
        let uploaded = self.transport.send(HttpRequest {
            method: "PUT".into(),
            url: upload_url,
            headers: vec![("content-length".into(), request.bytes.len().to_string())],
            body: request.bytes,
        })?;
        let _internal_key = reference.key;
        if !(200..300).contains(&uploaded.status) {
            return Err(format!("CLOUD_HTTP_STATUS_{}", uploaded.status));
        }
        Ok(BlobUploadResponse {
            object_ref_id: reference.object_ref_id,
            expires_at_ms: reference.expires_at_ms,
        })
    }

    fn ensure_session(&self) -> Result<SessionTokens, String> {
        let session = self.device_key.load_session()?.ok_or("CLOUD_SIGNED_OUT")?;
        if session.expires_at_ms > Self::now_ms()?.saturating_add(REFRESH_SKEW_MS) {
            return Ok(session);
        }
        self.refresh_session(session)
    }

    fn refresh_session(&self, current: SessionTokens) -> Result<SessionTokens, String> {
        let url = self.url("/v1/auth/refresh")?;
        let proof = self.device_key.dpop_proof(
            "POST",
            &url,
            Some(&current.refresh_token),
            Self::now_seconds()?,
        )?;
        let body = serde_json::json!({ "refreshToken": current.refresh_token });
        let response = self.send_json(
            "POST",
            "/v1/auth/refresh",
            Some(&body),
            vec![("dpop".into(), proof)],
        )?;
        if matches!(response.status, 401 | 403 | 409) {
            self.device_key.mark_reauth_required()?;
            return Err("CLOUD_REAUTH_REQUIRED".into());
        }
        let rotated = parse_token_response(&response)?;
        if current.sid.is_some() && rotated.sid.is_some() && current.sid != rotated.sid {
            self.device_key.mark_reauth_required()?;
            return Err("CLOUD_REAUTH_REQUIRED".into());
        }
        let rotated = SessionTokens {
            sid: rotated.sid.or(current.sid),
            ..rotated
        };
        self.device_key.rotate_session(&rotated)?;
        Ok(rotated)
    }
}

fn parse_token_response(response: &HttpResponse) -> Result<SessionTokens, String> {
    let body = CloudAuthService::json_body(response, 200)?;
    let token: TokenResponse =
        serde_json::from_value(body).map_err(|_| "CLOUD_TOKEN_RESPONSE_INVALID")?;
    if token.token_type != "DPoP"
        || token.access_token.is_empty()
        || token.refresh_token.is_empty()
        || token.expires_in == 0
        || token.expires_in > 3600
    {
        return Err("CLOUD_TOKEN_RESPONSE_INVALID".into());
    }
    let expires_at_ms = CloudAuthService::now_ms()?
        .checked_add(token.expires_in.saturating_mul(1000))
        .ok_or("CLOUD_TOKEN_RESPONSE_INVALID")?;
    let sid = jwt_claim_string(&token.access_token, "sid");
    Ok(SessionTokens {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at_ms,
        sid,
    })
}

fn is_base64url_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
}

fn has_exact_keys(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    required.iter().all(|key| object.contains_key(*key))
        && object
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}

fn validate_sync_push_request(request: &Value) -> Result<(), String> {
    let encoded = serde_json::to_vec(request).map_err(|_| "CLOUD_SYNC_REQUEST_INVALID")?;
    if encoded.len() > MAX_SYNC_PUSH_BYTES
        || !has_exact_keys(
            request,
            &[
                "protocolVersion",
                "schemaVersion",
                "nodeId",
                "idempotencyKey",
                "changes",
            ],
            &[],
        )
        || request["protocolVersion"] != 1
        || request["schemaVersion"] != "cloud-sync-v1"
    {
        return Err("CLOUD_SYNC_REQUEST_INVALID".into());
    }
    let node_id = request["nodeId"].as_str().unwrap_or_default();
    let idempotency = request["idempotencyKey"].as_str().unwrap_or_default();
    let valid_identifier = |value: &str, minimum: usize, maximum: usize| {
        (minimum..=maximum).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    };
    if !valid_identifier(node_id, 1, 128) || !valid_identifier(idempotency, 16, 256) {
        return Err("CLOUD_SYNC_REQUEST_INVALID".into());
    }
    let changes = request["changes"]
        .as_array()
        .filter(|changes| changes.len() <= 500)
        .ok_or("CLOUD_SYNC_REQUEST_INVALID")?;
    for change in changes {
        if !has_exact_keys(
            change,
            &[
                "table",
                "id",
                "tenantId",
                "workspaceId",
                "op",
                "fields",
                "hlc",
            ],
            &[],
        ) || change["table"].as_str().is_none_or(|table| {
            table.is_empty()
                || table.len() > 64
                || !table
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
                || !table.as_bytes()[0].is_ascii_lowercase()
        }) || change["id"]
            .as_str()
            .is_none_or(|id| !is_canonical_uuid(id))
            || !change["fields"].is_object()
        {
            return Err("CLOUD_SYNC_REQUEST_INVALID".into());
        }
    }
    Ok(())
}

fn validate_sync_push_response(request: &Value, response: &Value) -> Result<(), String> {
    if !has_exact_keys(
        response,
        &[
            "accepted",
            "conflicts",
            "serverSeq",
            "rejected",
            "conflictHistory",
            "replayed",
            "changeOutcomes",
        ],
        &[],
    ) {
        return Err("CLOUD_SYNC_RESPONSE_INVALID".into());
    }
    let changes = request["changes"]
        .as_array()
        .ok_or("CLOUD_SYNC_RESPONSE_INVALID")?;
    let outcomes = response["changeOutcomes"]
        .as_array()
        .filter(|outcomes| outcomes.len() == changes.len() && outcomes.len() <= 500)
        .ok_or("CLOUD_SYNC_RESPONSE_INVALID")?;
    for (index, (change, outcome)) in changes.iter().zip(outcomes).enumerate() {
        validate_sync_change_outcome(change, outcome, index)?;
    }
    let rejected = response["rejected"]
        .as_array()
        .filter(|items| items.len() <= 500)
        .ok_or("CLOUD_SYNC_RESPONSE_INVALID")?;
    let mut rejection_count = 0usize;
    for (index, outcome) in outcomes.iter().enumerate() {
        if let Some(code) = outcome.get("rejectionCode") {
            let entry = rejected
                .get(rejection_count)
                .ok_or("CLOUD_SYNC_RESPONSE_INVALID")?;
            if !has_exact_keys(entry, &["index", "changeId", "code"], &[])
                || entry["index"].as_u64() != Some(index as u64)
                || entry["changeId"] != outcome["changeId"]
                || entry["code"] != *code
            {
                return Err("CLOUD_SYNC_RESPONSE_INVALID".into());
            }
            rejection_count += 1;
        }
    }
    if rejection_count != rejected.len() {
        return Err("CLOUD_SYNC_RESPONSE_INVALID".into());
    }
    let history = response["conflictHistory"]
        .as_array()
        .filter(|items| items.len() <= 128_000)
        .ok_or("CLOUD_SYNC_RESPONSE_INVALID")?;
    for item in history {
        if !has_exact_keys(
            item,
            &[
                "table",
                "rowId",
                "field",
                "winningHlc",
                "losingHlc",
                "losingValue",
            ],
            &[],
        ) || item["table"].as_str().is_none_or(str::is_empty)
            || item["rowId"]
                .as_str()
                .is_none_or(|id| !is_canonical_uuid(id))
            || item["field"].as_str().is_none_or(str::is_empty)
            || item["winningHlc"].as_str().is_none_or(|hlc| !is_hlc(hlc))
            || item["losingHlc"].as_str().is_none_or(|hlc| !is_hlc(hlc))
        {
            return Err("CLOUD_SYNC_RESPONSE_INVALID".into());
        }
    }
    if response["accepted"].as_u64().is_none()
        || response["conflicts"].as_u64().is_none()
        || response["serverSeq"].as_str().is_none_or(|seq| {
            !(1..=20).contains(&seq.len()) || !seq.bytes().all(|byte| byte.is_ascii_digit())
        })
        || !response["replayed"].is_boolean()
    {
        return Err("CLOUD_SYNC_RESPONSE_INVALID".into());
    }
    Ok(())
}

fn is_hlc(value: &str) -> bool {
    let Some((timestamp, rest)) = value.split_once('-') else {
        return false;
    };
    let Some((counter, node)) = rest.split_once('-') else {
        return false;
    };
    timestamp.len() == 13
        && timestamp.bytes().all(|byte| byte.is_ascii_digit())
        && counter.len() == 4
        && counter
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && (1..=32).contains(&node.len())
        && node
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

fn validate_sync_change_outcome(
    change: &Value,
    result: &Value,
    index: usize,
) -> Result<(), String> {
    let required = [
        "index",
        "changeId",
        "table",
        "rowId",
        "outcome",
        "appliedFields",
        "unchangedFields",
        "conflictedFields",
    ];
    if !has_exact_keys(result, &required, &["rejectionCode"])
        || result["index"].as_u64() != Some(index as u64)
        || result["changeId"] != change["id"]
        || result["rowId"] != change["id"]
        || result["table"] != change["table"]
    {
        return Err("CLOUD_SYNC_RESPONSE_INVALID".into());
    }
    let parse_fields = |key: &str| -> Result<Vec<String>, String> {
        let fields = result[key]
            .as_array()
            .filter(|fields| fields.len() <= 256)
            .ok_or("CLOUD_SYNC_RESPONSE_INVALID")?;
        let mut parsed = Vec::with_capacity(fields.len());
        for field in fields {
            let value = field.as_str().ok_or("CLOUD_SYNC_RESPONSE_INVALID")?;
            if value.is_empty()
                || value.len() > 64
                || !value.as_bytes()[0].is_ascii_lowercase()
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
            {
                return Err("CLOUD_SYNC_RESPONSE_INVALID".into());
            }
            parsed.push(value.to_string());
        }
        if parsed.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err("CLOUD_SYNC_RESPONSE_INVALID".into());
        }
        Ok(parsed)
    };
    let applied = parse_fields("appliedFields")?;
    let unchanged = parse_fields("unchangedFields")?;
    let conflicted = parse_fields("conflictedFields")?;
    let rejected = result.get("rejectionCode").is_some();
    if rejected {
        let code = result["rejectionCode"]
            .as_str()
            .ok_or("CLOUD_SYNC_RESPONSE_INVALID")?;
        if !matches!(
            code,
            "AUTH_SCOPE_MISMATCH"
                | "UNKNOWN_TABLE"
                | "SERVER_AUTHORITY"
                | "LOCAL_ONLY"
                | "APPEND_REQUIRED"
                | "UPSERT_REQUIRED"
                | "PERMISSION_DENIED"
                | "IMMUTABLE_FIELD"
                | "ACTOR_FIELD"
                | "GUARDED_FIELD"
                | "INVALID_ROW"
                | "CLOCK_SKEW"
                | "TOMBSTONED"
                | "KILL_SWITCH_ENGAGED"
        ) || !applied.is_empty()
            || !unchanged.is_empty()
            || !conflicted.is_empty()
            || result["outcome"] != "rejected"
        {
            return Err("CLOUD_SYNC_RESPONSE_INVALID".into());
        }
        return Ok(());
    }
    let fields = change["fields"]
        .as_object()
        .ok_or("CLOUD_SYNC_RESPONSE_INVALID")?;
    let mut all = applied.clone();
    all.extend(unchanged.iter().cloned());
    all.extend(conflicted.iter().cloned());
    all.sort();
    if all.len() != fields.len()
        || all.windows(2).any(|pair| pair[0] == pair[1])
        || !all.iter().eq(fields.keys())
    {
        return Err("CLOUD_SYNC_RESPONSE_INVALID".into());
    }
    let op = change["op"].as_str().unwrap_or_default();
    match result["outcome"].as_str() {
        Some("committed") if !applied.is_empty() || op == "delete" => Ok(()),
        Some("unchanged") if applied.is_empty() && conflicted.is_empty() => Ok(()),
        Some("conflict") if applied.is_empty() && !conflicted.is_empty() => Ok(()),
        _ => Err("CLOUD_SYNC_RESPONSE_INVALID".into()),
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

fn jwt_claim_string(token: &str, claim: &str) -> Option<String> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;
    value.get(claim)?.as_str().map(str::to_owned)
}

fn extract_callback_code(location: &str, pending: &PendingAuth) -> Result<String, String> {
    let callback = tauri::Url::parse(location).map_err(|_| "CLOUD_CALLBACK_INVALID")?;
    let expected =
        tauri::Url::parse(&pending.redirect_uri).map_err(|_| "CLOUD_CALLBACK_INVALID")?;
    if callback.scheme() != "http"
        || !matches!(
            callback.host_str(),
            Some("127.0.0.1") | Some("[::1]") | Some("::1")
        )
        || callback.origin() != expected.origin()
        || callback.path() != expected.path()
        || callback.username() != ""
        || callback.password().is_some()
        || callback.fragment().is_some()
    {
        return Err("CLOUD_CALLBACK_INVALID".into());
    }
    let mut code = None;
    let mut state = None;
    for (key, value) in callback.query_pairs() {
        match key.as_ref() {
            "code" if code.is_none() => code = Some(value.into_owned()),
            "state" if state.is_none() => state = Some(value.into_owned()),
            _ => return Err("CLOUD_CALLBACK_INVALID".into()),
        }
    }
    let code = code
        .filter(|code| !code.is_empty() && code.len() <= 4096)
        .ok_or("CLOUD_CALLBACK_INVALID")?;
    if state.as_deref() != Some(pending.state.as_str()) {
        return Err("CLOUD_CALLBACK_STATE_MISMATCH".into());
    }
    Ok(code)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct MemoryStore(Mutex<std::collections::HashMap<String, String>>);

    impl CredentialStore for MemoryStore {
        fn get(&self, id: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(id).cloned())
        }
        fn set(&self, id: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), value.into());
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeTransport {
        requests: Mutex<Vec<HttpRequest>>,
        responses: Mutex<VecDeque<HttpResponse>>,
    }

    impl FakeTransport {
        fn with_responses(responses: Vec<HttpResponse>) -> Self {
            Self {
                requests: Mutex::new(Vec::new()),
                responses: Mutex::new(responses.into()),
            }
        }

        fn take_requests(&self) -> Vec<HttpRequest> {
            std::mem::take(&mut *self.requests.lock().unwrap())
        }
    }

    impl HttpTransport for FakeTransport {
        fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| "TEST_RESPONSE_MISSING".into())
        }
    }

    #[derive(Default)]
    struct FakeSidecarTransport {
        records: Mutex<Vec<(u16, String, Value)>>,
    }

    impl SidecarTransport for FakeSidecarTransport {
        fn record_cloud_push(
            &self,
            port: u16,
            token: &str,
            envelope: &Value,
        ) -> Result<(), String> {
            self.records
                .lock()
                .unwrap()
                .push((port, token.into(), envelope.clone()));
            Ok(())
        }
    }

    fn response(status: u16, body: Value) -> HttpResponse {
        HttpResponse {
            status,
            headers: Vec::new(),
            body: serde_json::to_vec(&body).unwrap(),
        }
    }

    fn tokens(access: &str, refresh: &str, expires_in: u64) -> Value {
        serde_json::json!({
            "accessToken": access,
            "refreshToken": refresh,
            "expiresIn": expires_in,
            "tokenType": "DPoP",
        })
    }

    fn sync_request() -> Value {
        serde_json::json!({
            "protocolVersion": 1,
            "schemaVersion": "cloud-sync-v1",
            "nodeId": "device-node-1",
            "idempotencyKey": "request-key-000001",
            "changes": [{
                "table": "settings",
                "id": "018f47a1-7b2c-7d0a-8d11-123456789abc",
                "tenantId": "018f47a1-7b2c-7d0a-8d11-123456789abd",
                "workspaceId": null,
                "op": "upsert",
                "fields": {"display_name": {"value": "Ada", "hlc": "1712345678901-0001-node1", "baseHlc": null}},
                "hlc": "1712345678901-0001-node1"
            }]
        })
    }

    fn sync_response() -> Value {
        serde_json::json!({
            "accepted": 1,
            "conflicts": 0,
            "serverSeq": "9",
            "rejected": [],
            "conflictHistory": [],
            "replayed": false,
            "changeOutcomes": [{
                "index": 0,
                "changeId": "018f47a1-7b2c-7d0a-8d11-123456789abc",
                "table": "settings",
                "rowId": "018f47a1-7b2c-7d0a-8d11-123456789abc",
                "outcome": "committed",
                "appliedFields": ["display_name"],
                "unchangedFields": [],
                "conflictedFields": []
            }]
        })
    }

    fn service(transport: Arc<FakeTransport>, store: Arc<MemoryStore>) -> CloudAuthService {
        CloudAuthService::for_test(
            Some("https://cloud.test".into()),
            transport,
            Arc::new(FakeSidecarTransport::default()),
            store,
        )
        .unwrap()
    }

    #[test]
    fn sidecar_sender_uses_fixed_loopback_path_and_native_only_header() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 2048];
            loop {
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..count]);
                let Some(split) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&bytes[..split]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if bytes.len() >= split + 4 + length {
                    break;
                }
            }
            let body = r#"{"status":"recorded"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            String::from_utf8(bytes).unwrap()
        });
        let envelope =
            serde_json::json!({"request":{"protocolVersion":1},"response":{"changeOutcomes":[]}});
        ReqwestSidecarTransport::new()
            .unwrap()
            .record_cloud_push(port, &"b".repeat(43), &envelope)
            .unwrap();
        let request = server.join().unwrap().to_ascii_lowercase();
        assert!(request.starts_with("post /internal/native/cloud-sync/push http/1.1\r\n"));
        let expected_header = "x-xyra-native-sync-token: ".to_owned() + &"b".repeat(43);
        assert!(request.contains(&expected_header));
        assert!(request.contains(
            &serde_json::to_string(&envelope)
                .unwrap()
                .to_ascii_lowercase()
        ));
    }

    #[test]
    fn begin_stores_pkce_and_returns_options_without_state_or_private_key() {
        let fake = Arc::new(FakeTransport::with_responses(vec![response(
            200,
            serde_json::json!({
                "transactionId": "tx-1",
                "state": "server-state",
                "nonce": "server-nonce",
                "options": {"challenge":"abc"},
            }),
        )]));
        let store = Arc::new(MemoryStore::default());
        let client = service(fake.clone(), store.clone());
        let begin = client
            .begin(AuthBeginRequest {
                workspace_id: "workspace-1".into(),
            })
            .unwrap();
        assert_eq!(begin.transaction_id, "tx-1");
        assert_eq!(begin.options["challenge"], "abc");
        assert!(serde_json::to_string(&begin).unwrap().contains("options"));
        assert!(!serde_json::to_string(&begin).unwrap().contains("state"));
        let requests = fake.take_requests();
        let request_body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(requests[0].url, "https://cloud.test/v1/auth/passkey/begin");
        assert_eq!(request_body["workspaceId"], "workspace-1");
        assert_eq!(request_body["deviceJwk"]["kty"], "OKP");
        assert!(request_body["deviceJwk"]["d"].is_null());
        let redirect_uri = request_body["redirectUri"].as_str().unwrap();
        assert!(redirect_uri.starts_with("http://127.0.0.1:"));
        let redirect = tauri::Url::parse(redirect_uri).unwrap();
        let port = redirect.port().unwrap();
        // The loopback port stays reserved while passkey UI is in progress.
        assert!(TcpListener::bind(("127.0.0.1", port)).is_err());
        let pending: PendingAuth = client.device_key.load_pending_auth().unwrap().unwrap();
        assert_eq!(pending.transaction_id, "tx-1");
        assert_eq!(pending.state, "server-state");
        assert_eq!(pending.verifier.len(), 43);
        assert_eq!(
            URL_SAFE_NO_PAD
                .encode(digest(&SHA256, pending.verifier.as_bytes()).as_ref())
                .len(),
            43
        );
        assert_eq!(store.0.lock().unwrap().len(), 2);
    }

    #[test]
    fn cloud_sync_ack_is_validated_and_forwarded_only_to_native_sidecar_channel() {
        let fake = Arc::new(FakeTransport::with_responses(vec![response(
            200,
            sync_response(),
        )]));
        let local = Arc::new(FakeSidecarTransport::default());
        let store = Arc::new(MemoryStore::default());
        let client = CloudAuthService::for_test(
            Some("https://cloud.test".into()),
            fake.clone(),
            local.clone(),
            store.clone(),
        )
        .unwrap();
        client
            .device_key
            .store_session(&SessionTokens {
                access_token: "access-live".into(),
                refresh_token: "refresh-live".into(),
                expires_at_ms: CloudAuthService::now_ms().unwrap() + 600_000,
                sid: Some("family-1".into()),
            })
            .unwrap();

        let cloud_request = sync_request();
        client
            .sync_push_to_sidecar(cloud_request.clone(), 43125, &"A".repeat(43))
            .unwrap();

        let cloud = fake.take_requests();
        assert_eq!(cloud[0].url, "https://cloud.test/v1/sync/push");
        assert!(cloud[0].headers.iter().any(|(name, _)| name == "dpop"));
        assert!(cloud[0]
            .headers
            .iter()
            .any(|(name, value)| name == "authorization" && value == "Bearer access-live"));
        let recorded = local.records.lock().unwrap();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].0, 43125);
        assert_eq!(recorded[0].1, "A".repeat(43));
        assert_eq!(recorded[0].2["request"], cloud_request);
        assert_eq!(recorded[0].2["response"], sync_response());
        // The IPC command returns unit; outcome JSON is sent solely over the private local channel.
    }

    #[test]
    fn cloud_sync_ack_rejects_unbound_or_malformed_outcomes_before_local_delivery() {
        let request = sync_request();
        let mut wrong_id = sync_response();
        wrong_id["changeOutcomes"][0]["changeId"] = "018f47a1-7b2c-7d0a-8d11-123456789abd".into();
        assert!(validate_sync_push_response(&request, &wrong_id).is_err());
        let mut overlap = sync_response();
        overlap["changeOutcomes"][0]["unchangedFields"] = serde_json::json!(["display_name"]);
        assert!(validate_sync_push_response(&request, &overlap).is_err());
        let mut unknown = sync_response();
        unknown["changeOutcomes"][0]["unexpected"] = true.into();
        assert!(validate_sync_push_response(&request, &unknown).is_err());
    }

    #[test]
    fn callback_requires_exact_loopback_port_and_state_and_unique_code() {
        let pending = PendingAuth {
            transaction_id: "tx".into(),
            state: "state-1".into(),
            nonce: "nonce".into(),
            verifier: "verifier".into(),
            redirect_uri: "http://127.0.0.1:42001".into(),
            created_at_ms: 1,
        };
        assert_eq!(
            extract_callback_code("http://127.0.0.1:42001/?code=one&state=state-1", &pending)
                .unwrap(),
            "one"
        );
        for location in [
            "http://127.0.0.1:42002/?code=one&state=state-1",
            "http://127.0.0.1:42001/?code=one&state=wrong",
            "https://127.0.0.1:42001/?code=one&state=state-1",
            "http://evil.example:42001/?code=one&state=state-1",
            "http://127.0.0.1:42001/?code=one&code=two&state=state-1",
        ] {
            assert!(
                extract_callback_code(location, &pending).is_err(),
                "accepted {location}"
            );
        }
    }

    #[test]
    fn complete_exchanges_code_with_pkce_and_dpop_and_stores_tokens_atomically() {
        let store = Arc::new(MemoryStore::default());
        let fake = Arc::new(FakeTransport::default());
        let client = service(fake.clone(), store);
        let callback_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let callback_port = callback_listener.local_addr().unwrap().port();
        let redirect_uri = format!("http://127.0.0.1:{callback_port}");
        client
            .device_key
            .save_pending_auth(&PendingAuth {
                transaction_id: "tx-9".into(),
                state: "expected-state".into(),
                nonce: "server-nonce".into(),
                verifier: "a-fake-pkce-verifier".into(),
                redirect_uri: redirect_uri.clone(),
                created_at_ms: CloudAuthService::now_ms().unwrap(),
            })
            .unwrap();
        client
            .callback_listeners
            .lock()
            .unwrap()
            .insert("tx-9".into(), callback_listener);
        *fake.responses.lock().unwrap() = vec![
            HttpResponse {
                status: 303,
                headers: vec![(
                    "Location".into(),
                    format!("{redirect_uri}/?code=single-use&state=expected-state"),
                )],
                body: Vec::new(),
            },
            response(200, tokens("opaque.access", "opaque.refresh", 900)),
        ]
        .into();
        let result = client
            .complete(AuthCompleteRequest {
                transaction_id: "tx-9".into(),
                credential: serde_json::json!({"id":"credential-id"}),
            })
            .unwrap();
        assert!(matches!(result.status, SessionStatus::Authenticated));
        let requests = fake.take_requests();
        assert_eq!(requests.len(), 2);
        let token_body: Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert_eq!(token_body["code"], "single-use");
        assert_eq!(token_body["verifier"], "a-fake-pkce-verifier");
        let dpop = requests[1]
            .headers
            .iter()
            .find(|(name, _)| name == "dpop")
            .unwrap()
            .1
            .clone();
        let payload = dpop.split('.').nth(1).unwrap();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        assert_eq!(
            claims["ath"],
            URL_SAFE_NO_PAD.encode(digest(&SHA256, b"single-use").as_ref())
        );
        let saved = client.device_key.load_session().unwrap().unwrap();
        assert_eq!(saved.access_token, "opaque.access");
        assert!(client
            .device_key
            .load_pending_auth::<PendingAuth>()
            .unwrap()
            .is_none());
    }

    #[test]
    fn refresh_rotation_updates_pair_and_reuse_marks_reauth_required() {
        let store = Arc::new(MemoryStore::default());
        let fake = Arc::new(FakeTransport::with_responses(vec![
            response(200, tokens("access-rotated", "refresh-rotated", 900)),
            response(409, serde_json::json!({"code":"REFRESH_REUSE"})),
        ]));
        let client = service(fake.clone(), store);
        client
            .device_key
            .store_session(&SessionTokens {
                access_token: "access-old".into(),
                refresh_token: "refresh-old".into(),
                expires_at_ms: CloudAuthService::now_ms().unwrap(),
                sid: Some("family-1".into()),
            })
            .unwrap();
        let rotated = client.ensure_session().unwrap();
        assert_eq!(rotated.access_token, "access-rotated");
        assert_eq!(rotated.refresh_token, "refresh-rotated");
        assert_eq!(client.device_key.load_session().unwrap().unwrap(), rotated);
        assert_eq!(
            client.refresh_session(rotated),
            Err("CLOUD_REAUTH_REQUIRED".into())
        );
        assert_eq!(
            client.device_key.stored_session_status().unwrap(),
            StoredSessionStatus::ReauthRequired
        );
        let requests = fake.take_requests();
        for (request, bound) in requests.iter().zip(["refresh-old", "refresh-rotated"]) {
            let proof = request
                .headers
                .iter()
                .find(|(name, _)| name == "dpop")
                .unwrap()
                .1
                .clone();
            let payload = proof.split('.').nth(1).unwrap();
            let claims: Value =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
            assert_eq!(
                claims["ath"],
                URL_SAFE_NO_PAD.encode(digest(&SHA256, bound.as_bytes()).as_ref())
            );
        }
    }

    #[test]
    fn protected_request_refreshes_then_uses_access_token_dpop_and_route_policy() {
        let store = Arc::new(MemoryStore::default());
        let fake = Arc::new(FakeTransport::with_responses(vec![
            response(200, tokens("access-new", "refresh-new", 900)),
            response(200, serde_json::json!({"id":"ing-1"})),
        ]));
        let client = service(fake.clone(), store);
        client
            .device_key
            .store_session(&SessionTokens {
                access_token: "access-old".into(),
                refresh_token: "refresh-old".into(),
                expires_at_ms: CloudAuthService::now_ms().unwrap(),
                sid: None,
            })
            .unwrap();
        let response = client
            .authenticated_request(AuthenticatedRequest {
                path: "/v2/brain/ingestions".into(),
                method: "POST".into(),
                body: Some(serde_json::json!({"source":"test"})),
            })
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["id"], "ing-1");
        let requests = fake.take_requests();
        assert_eq!(requests[0].url, "https://cloud.test/v1/auth/refresh");
        assert_eq!(requests[1].url, "https://cloud.test/v2/brain/ingestions");
        assert!(requests[1]
            .headers
            .iter()
            .any(|(name, value)| name == "authorization" && value == "Bearer access-new"));
        let proof = requests[1]
            .headers
            .iter()
            .find(|(name, _)| name == "dpop")
            .unwrap()
            .1
            .split('.')
            .nth(1)
            .unwrap();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(proof).unwrap()).unwrap();
        assert_eq!(
            claims["ath"],
            URL_SAFE_NO_PAD.encode(digest(&SHA256, b"access-new").as_ref())
        );
    }

    #[test]
    fn logout_revokes_with_access_proof_and_clears_local_state_even_without_origin() {
        let store = Arc::new(MemoryStore::default());
        let fake = Arc::new(FakeTransport::with_responses(vec![response(
            200,
            serde_json::json!({"status":"revoked"}),
        )]));
        let client = service(fake.clone(), store.clone());
        client
            .device_key
            .store_session(&SessionTokens {
                access_token: "access-logout".into(),
                refresh_token: "refresh-logout".into(),
                expires_at_ms: CloudAuthService::now_ms().unwrap() + 60_000,
                sid: Some("family-2".into()),
            })
            .unwrap();
        assert!(matches!(
            client.logout().unwrap().status,
            SessionStatus::SignedOut
        ));
        let requests = fake.take_requests();
        assert_eq!(requests[0].url, "https://cloud.test/v1/auth/logout");
        assert!(requests[0]
            .headers
            .iter()
            .any(|(name, value)| name == "authorization" && value == "Bearer access-logout"));
        assert!(client.device_key.load_session().unwrap().is_none());

        let offline = CloudAuthService::for_test(
            None,
            fake,
            Arc::new(FakeSidecarTransport::default()),
            store,
        )
        .unwrap();
        assert!(matches!(
            offline.logout().unwrap().status,
            SessionStatus::SignedOut
        ));
        assert_eq!(
            offline.session_status().unwrap().status,
            SessionStatus::SignedOut
        );
    }

    #[test]
    fn upload_uses_native_signed_relative_path_raw_bytes_and_decimal_length() {
        let store = Arc::new(MemoryStore::default());
        let fake = Arc::new(FakeTransport::with_responses(vec![
            response(
                200,
                serde_json::json!({
                    "url":"/v1/blobs/access/abc_DEF-123",
                    "objectRefId":"obj-1",
                    "expiresAtMs": 1_800_000_000_000u64,
                    "mode":"PUT",
                    "key":"tenant/internal/private-key",
                }),
            ),
            HttpResponse {
                status: 200,
                headers: Vec::new(),
                body: Vec::new(),
            },
        ]));
        let client = service(fake.clone(), store);
        client
            .device_key
            .store_session(&SessionTokens {
                access_token: "access-upload".into(),
                refresh_token: "refresh-upload".into(),
                expires_at_ms: CloudAuthService::now_ms().unwrap() + 120_000,
                sid: None,
            })
            .unwrap();
        let result = client
            .upload_blob(BlobUploadRequest {
                name: "input.json".into(),
                expires_in_sec: 60,
                ingestion_id: "ing-1".into(),
                bytes: vec![0, 1, 2, 255],
            })
            .unwrap();
        assert_eq!(result.object_ref_id, "obj-1");
        let requests = fake.take_requests();
        assert_eq!(requests[0].url, "https://cloud.test/v1/blobs/ref");
        assert_eq!(
            requests[1].url,
            "https://cloud.test/v1/blobs/access/abc_DEF-123"
        );
        assert_eq!(requests[1].method, "PUT");
        assert_eq!(requests[1].body, vec![0, 1, 2, 255]);
        assert_eq!(
            requests[1].headers,
            vec![("content-length".into(), "4".into())]
        );
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("tenant/internal"));
    }
}
