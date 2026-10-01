//! Native Cloud auth/session client. All network URLs come from the compiled origin registry;
//! `HttpTransport` is injectable so authentication and refresh behavior can be tested without a
//! live Worker or any environment-configurable host.

use std::collections::HashMap;
use std::io::Read;
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
#[cfg(test)]
use crate::cloud_crypto::CredentialStore;
use crate::cloud_crypto::{DeviceKey, SessionTokens, StoredSessionStatus, WindowsCredentialStore};

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES: usize = 256 * 1024;
const REFRESH_SKEW_MS: u64 = 60_000;
const AUTH_TTL_MS: u64 = 10 * 60_000;
const MAX_SYNC_PUSH_BYTES: usize = 1_000_000;
const MAX_SIGNAL_RESPONSE_BYTES: usize = 64 * 1024;
const SIGNAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const INVEST_SIGNAL_CONSUME_PROTOCOL: &str = "xyra.invest.signal.consume.v1";

#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub timeout: Option<Duration>,
    pub max_response_bytes: Option<usize>,
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
    fn process_advisory_signal(
        &self,
        port: u16,
        token: &str,
        claim: &Value,
    ) -> Result<String, String>;
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

    fn process_advisory_signal(
        &self,
        port: u16,
        token: &str,
        claim: &Value,
    ) -> Result<String, String> {
        if port == 0 || token.len() != 43 || !token.bytes().all(is_base64url_byte) {
            return Err("LOCAL_SERVICE_UNAVAILABLE".into());
        }
        let response = self
            .client
            .post(format!(
                "http://127.0.0.1:{port}/internal/native/invest/signals/consume"
            ))
            .header("x-xyra-native-sync-token", token)
            .json(claim)
            .send()
            .map_err(|_| "LOCAL_SERVICE_UNAVAILABLE")?;
        if response.status() != reqwest::StatusCode::OK {
            return Err("INVEST_SIGNAL_PROCESS_FAILED".into());
        }
        let mut bytes = Vec::new();
        response
            .take(257)
            .read_to_end(&mut bytes)
            .map_err(|_| "INVEST_SIGNAL_PROCESS_FAILED")?;
        if bytes.len() > 256 {
            return Err("INVEST_SIGNAL_PROCESS_FAILED".into());
        }
        let body: Value =
            serde_json::from_slice(&bytes).map_err(|_| "INVEST_SIGNAL_PROCESS_FAILED")?;
        if !has_exact_keys(&body, &["decisionId"], &[])
            || body["decisionId"]
                .as_str()
                .is_none_or(|id| !is_canonical_uuid(id))
        {
            return Err("INVEST_SIGNAL_PROCESS_FAILED".into());
        }
        Ok(body["decisionId"].as_str().unwrap().to_owned())
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
        if let Some(timeout) = request.timeout {
            builder = builder.timeout(timeout);
        }
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
        let response_limit = request
            .max_response_bytes
            .unwrap_or(MAX_RESPONSE_BYTES)
            .min(MAX_RESPONSE_BYTES);
        let mut body = Vec::new();
        response
            .by_ref()
            .take((response_limit + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|_| "CLOUD_RESPONSE_READ_FAILED")?;
        if body.len() > response_limit {
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
    #[serde(default)]
    key_algorithm: crate::cloud_crypto::DpopAlgorithm,
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

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SignalConsumeResponse {
    pub status: SignalConsumeStatus,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SignalConsumeStatus {
    Empty,
    Processed,
}

pub struct CloudAuthService {
    origin: Option<String>,
    transport: Arc<dyn HttpTransport>,
    sidecar_transport: Arc<dyn SidecarTransport>,
    device_key: DeviceKey,
    callback_listeners: Mutex<HashMap<String, TcpListener>>,
}

impl CloudAuthService {
    #[cfg(test)]
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

    fn build_with_device_key(
        origin: Option<String>,
        transport: Arc<dyn HttpTransport>,
        sidecar_transport: Arc<dyn SidecarTransport>,
        device_key: DeviceKey,
    ) -> Result<Self, String> {
        if let Some(origin) = origin.as_deref() {
            crate::cloud_auth::validate_https_origin(origin)
                .map_err(|_| "CLOUD_ORIGIN_NOT_CONFIGURED")?;
        }
        Ok(Self {
            origin,
            transport,
            sidecar_transport,
            device_key,
            callback_listeners: Mutex::new(HashMap::new()),
        })
    }

    pub fn production() -> Result<Self, String> {
        let origin = crate::cloud_auth::selected_cloud_origin()?.map(str::to_owned);
        Self::build_with_device_key(
            origin,
            Arc::new(ReqwestTransport::new()?),
            Arc::new(ReqwestSidecarTransport::new()?),
            DeviceKey::production(Arc::new(WindowsCredentialStore))?,
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
        headers: Vec<(String, String)>,
    ) -> Result<HttpResponse, String> {
        self.send_json_with_timeout(method, path, body, headers, None)
    }

    fn send_json_with_timeout(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        headers: Vec<(String, String)>,
        timeout: Option<Duration>,
    ) -> Result<HttpResponse, String> {
        self.send_json_with_limits(method, path, body, headers, timeout, None)
    }

    fn send_json_with_limits(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        mut headers: Vec<(String, String)>,
        timeout: Option<Duration>,
        max_response_bytes: Option<usize>,
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
            timeout,
            max_response_bytes,
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

    fn random_uuid() -> Result<String, String> {
        let mut bytes = [0u8; 16];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| "CLOUD_RANDOM_UNAVAILABLE")?;
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        Ok(format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9],
            bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
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
            key_algorithm: self.device_key.current_algorithm(),
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

    /// Claims and consumes one Cloud advisory signal entirely inside the native process.
    /// Neither the verified signal nor the Invest decision id is returned to WebView JS.
    pub fn consume_advisory_signal(
        &self,
        sidecar_port: u16,
        native_sync_token: &str,
    ) -> Result<SignalConsumeResponse, String> {
        self.origin()?;
        if sidecar_port == 0
            || native_sync_token.len() != 43
            || !native_sync_token.bytes().all(is_base64url_byte)
        {
            return Err("LOCAL_SERVICE_UNAVAILABLE".into());
        }
        let claim_key = Self::random_uuid()?;
        let claim_request = serde_json::json!({
            "protocol": INVEST_SIGNAL_CONSUME_PROTOCOL,
            "idempotencyKey": claim_key,
        });
        let claim_response = self.signal_request("/v1/invest/signals/claim", &claim_request)?;
        let claim = parse_signal_claim(&claim_response.body)?;
        if claim["status"] == "empty" {
            return Ok(SignalConsumeResponse {
                status: SignalConsumeStatus::Empty,
            });
        }

        let event_id = claim["signal"]["eventId"]
            .as_str()
            .ok_or("CLOUD_SIGNAL_RESPONSE_INVALID")?
            .to_owned();
        let payload_digest = claim["signal"]["payloadDigest"]
            .as_str()
            .ok_or("CLOUD_SIGNAL_RESPONSE_INVALID")?
            .to_owned();
        let lease_id = claim["lease"]["leaseId"]
            .as_str()
            .ok_or("CLOUD_SIGNAL_RESPONSE_INVALID")?
            .to_owned();
        let decision_id = self.sidecar_transport.process_advisory_signal(
            sidecar_port,
            native_sync_token,
            &claim,
        )?;
        let ack_request = serde_json::json!({
            "protocol": INVEST_SIGNAL_CONSUME_PROTOCOL,
            "eventId": event_id,
            "payloadDigest": payload_digest,
            "leaseId": lease_id,
            "decisionId": decision_id,
            "idempotencyKey": claim_key,
        });
        let ack_response = self.signal_request("/v1/invest/signals/ack", &ack_request)?;
        validate_signal_ack(&ack_response.body, &ack_request)?;
        Ok(SignalConsumeResponse {
            status: SignalConsumeStatus::Processed,
        })
    }

    fn signal_request(&self, path: &str, body: &Value) -> Result<HttpResponse, String> {
        let allowed = matches!(path, "/v1/invest/signals/claim" | "/v1/invest/signals/ack");
        if !allowed {
            return Err("CLOUD_ROUTE_NOT_ALLOWED".into());
        }
        let session = self.ensure_session()?;
        let url = self.url(path)?;
        let proof = self.device_key.dpop_proof(
            "POST",
            &url,
            Some(&session.access_token),
            Self::now_seconds()?,
        )?;
        let response = self.send_json_with_limits(
            "POST",
            path,
            Some(body),
            vec![
                (
                    "authorization".into(),
                    format!("Bearer {}", session.access_token),
                ),
                ("dpop".into(), proof),
            ],
            Some(SIGNAL_REQUEST_TIMEOUT),
            Some(MAX_SIGNAL_RESPONSE_BYTES),
        )?;
        if response.status != 200 {
            return Err(format!("CLOUD_HTTP_STATUS_{}", response.status));
        }
        Ok(response)
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
            timeout: None,
            max_response_bytes: None,
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

fn parse_signal_claim(bytes: &[u8]) -> Result<Value, String> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| "CLOUD_SIGNAL_RESPONSE_INVALID")?;
    if has_exact_keys(&value, &["status"], &[]) && value["status"] == "empty" {
        return Ok(value);
    }
    if !has_exact_keys(&value, &["status", "lease", "signal"], &[])
        || value["status"] != "claimed"
        || !has_exact_keys(&value["lease"], &["leaseId", "fence", "expiresAt"], &[])
        || !has_exact_keys(
            &value["signal"],
            &[
                "protocol",
                "eventId",
                "occurredAt",
                "expiresAt",
                "algorithmId",
                "signalId",
                "symbol",
                "side",
                "quantity",
                "sourceId",
                "tenantId",
                "workspaceId",
                "receivedAt",
                "payloadDigest",
                "verification",
            ],
            &[],
        )
        || !has_exact_keys(
            &value["signal"]["verification"],
            &["signature", "keyId"],
            &[],
        )
    {
        return Err("CLOUD_SIGNAL_RESPONSE_INVALID".into());
    }
    let lease = &value["lease"];
    let signal = &value["signal"];
    fn string<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
        v.get(key).and_then(Value::as_str)
    }
    let event_id = string(signal, "eventId").unwrap_or_default();
    let digest = string(signal, "payloadDigest").unwrap_or_default();
    let algorithm = string(signal, "algorithmId").unwrap_or_default();
    let symbol = string(signal, "symbol").unwrap_or_default();
    let quantity = string(signal, "quantity").unwrap_or_default();
    let valid_id = |v: &str| {
        (1..=128).contains(&v.len())
            && v.bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b':' | b'-'))
    };
    if string(lease, "leaseId").is_none_or(|v| !is_canonical_uuid(v))
        || lease["fence"].as_u64().is_none_or(|v| v == 0)
        || string(lease, "expiresAt").is_none_or(|v| !is_iso_utc_timestamp(v))
        || signal["protocol"] != "xyra.invest.signal.v1"
        || !valid_id(event_id)
        || !is_canonical_uuid(string(signal, "signalId").unwrap_or_default())
        || !is_canonical_uuid(string(signal, "sourceId").unwrap_or_default())
        || !is_canonical_uuid(string(signal, "tenantId").unwrap_or_default())
        || !is_canonical_uuid(string(signal, "workspaceId").unwrap_or_default())
        || !is_canonical_uuid(string(&signal["verification"], "keyId").unwrap_or_default())
        || signal["verification"]["signature"] != "verified"
        || !is_iso_utc_timestamp(string(signal, "occurredAt").unwrap_or_default())
        || !is_iso_utc_timestamp(string(signal, "expiresAt").unwrap_or_default())
        || !is_iso_utc_timestamp(string(signal, "receivedAt").unwrap_or_default())
        || !(1..=64).contains(&algorithm.len())
        || !algorithm.bytes().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b':' | b'-')
        })
        || !(1..=32).contains(&symbol.len())
        || !symbol.as_bytes()[0].is_ascii_uppercase() && !symbol.as_bytes()[0].is_ascii_digit()
        || !symbol.bytes().all(|c| {
            c.is_ascii_uppercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'/' | b'-')
        })
        || !matches!(string(signal, "side"), Some("buy" | "sell"))
        || !is_positive_signal_quantity(quantity)
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("CLOUD_SIGNAL_RESPONSE_INVALID".into());
    }
    Ok(value)
}

fn is_positive_signal_quantity(value: &str) -> bool {
    let (whole, fraction) = value
        .split_once('.')
        .map_or((value, None), |(whole, fraction)| (whole, Some(fraction)));
    if !(1..=18).contains(&whole.len())
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || (whole.len() > 1 && whole.starts_with('0'))
        || fraction.is_some_and(|part| {
            !(1..=12).contains(&part.len()) || !part.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return false;
    }
    whole.bytes().any(|byte| byte != b'0')
        || fraction.is_some_and(|part| part.bytes().any(|byte| byte != b'0'))
}

fn validate_signal_ack(bytes: &[u8], request: &Value) -> Result<(), String> {
    let response: Value = serde_json::from_slice(bytes).map_err(|_| "CLOUD_SIGNAL_ACK_INVALID")?;
    if has_exact_keys(
        &response,
        &[
            "status",
            "eventId",
            "payloadDigest",
            "decisionId",
            "acknowledgedAt",
            "replayed",
        ],
        &[],
    ) && response["status"] == "acked"
        && response["eventId"] == request["eventId"]
        && response["payloadDigest"] == request["payloadDigest"]
        && response["decisionId"] == request["decisionId"]
        && response["decisionId"]
            .as_str()
            .is_some_and(is_canonical_uuid)
        && response["acknowledgedAt"]
            .as_str()
            .is_some_and(is_iso_utc_timestamp)
        && response["replayed"].is_boolean()
    {
        Ok(())
    } else {
        Err("CLOUD_SIGNAL_ACK_INVALID".into())
    }
}

fn is_iso_utc_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    (value.len() == 20
        || (value.len() >= 22
            && value.len() <= 30
            && bytes.get(19) == Some(&b'.')
            && bytes[value.len() - 1] == b'Z'))
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
        && bytes.last() == Some(&b'Z')
        && bytes.iter().enumerate().all(|(i, b)| {
            [4, 7, 10, 13, 16, 19].contains(&i) || (i == value.len() - 1) || b.is_ascii_digit()
        })
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

        fn process_advisory_signal(
            &self,
            port: u16,
            token: &str,
            claim: &Value,
        ) -> Result<String, String> {
            self.records
                .lock()
                .unwrap()
                .push((port, token.into(), claim.clone()));
            Ok("018f47a1-7b2c-7d0a-8d11-123456789abc".into())
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

    fn signal_claim_response() -> Value {
        serde_json::json!({
            "status":"claimed",
            "lease":{"leaseId":"018f47a1-7b2c-7d0a-8d11-123456789abe","fence":2,"expiresAt":"2099-01-01T00:00:30Z"},
            "signal":{
                "protocol":"xyra.invest.signal.v1","eventId":"event-1","occurredAt":"2026-01-01T00:00:00Z","expiresAt":"2099-01-01T00:00:00Z",
                "algorithmId":"strategy.alpha","signalId":"018f47a1-7b2c-7d0a-8d11-123456789abd","symbol":"ACME","side":"buy","quantity":"1.25",
                "sourceId":"018f47a1-7b2c-7d0a-8d11-123456789aba","tenantId":"018f47a1-7b2c-7d0a-8d11-123456789abb","workspaceId":"018f47a1-7b2c-7d0a-8d11-123456789abc",
                "receivedAt":"2026-01-01T00:00:01Z","payloadDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "verification":{"signature":"verified","keyId":"018f47a1-7b2c-7d0a-8d11-123456789ac0"}
            }
        })
    }

    fn authenticated_signal_service(
        fake: Arc<FakeTransport>,
        sidecar: Arc<FakeSidecarTransport>,
    ) -> CloudAuthService {
        let store = Arc::new(MemoryStore::default());
        let client =
            CloudAuthService::build(Some("https://cloud.test".into()), fake, sidecar, store)
                .unwrap();
        client
            .device_key
            .store_session(&SessionTokens {
                access_token: "signal-access".into(),
                refresh_token: "signal-refresh".into(),
                expires_at_ms: u64::MAX,
                sid: Some("signal-session".into()),
            })
            .unwrap();
        client
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
    fn advisory_signal_empty_claim_is_private_and_uses_fixed_dpop_route() {
        let fake = Arc::new(FakeTransport::with_responses(vec![response(
            200,
            serde_json::json!({"status":"empty"}),
        )]));
        let sidecar = Arc::new(FakeSidecarTransport::default());
        let client = authenticated_signal_service(fake.clone(), sidecar.clone());
        let result = client
            .consume_advisory_signal(43123, &"A".repeat(43))
            .unwrap();
        assert_eq!(
            result,
            SignalConsumeResponse {
                status: SignalConsumeStatus::Empty
            }
        );
        assert!(sidecar.records.lock().unwrap().is_empty());
        let requests = fake.take_requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, "POST");
        assert_eq!(
            requests[0].url,
            "https://cloud.test/v1/invest/signals/claim"
        );
        assert_eq!(requests[0].timeout, Some(SIGNAL_REQUEST_TIMEOUT));
        assert!(requests[0]
            .headers
            .iter()
            .any(|(n, v)| n == "authorization" && v == "Bearer signal-access"));
        let proof = requests[0]
            .headers
            .iter()
            .find(|(n, _)| n == "dpop")
            .unwrap()
            .1
            .split('.')
            .nth(1)
            .unwrap();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(proof).unwrap()).unwrap();
        assert_eq!(claims["htu"], "https://cloud.test/v1/invest/signals/claim");
        assert_eq!(claims["htm"], "POST");
        assert_eq!(
            claims["ath"],
            URL_SAFE_NO_PAD.encode(digest(&SHA256, b"signal-access").as_ref())
        );
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body["protocol"], INVEST_SIGNAL_CONSUME_PROTOCOL);
        assert!(is_canonical_uuid(body["idempotencyKey"].as_str().unwrap()));
        assert!(fake.take_requests().is_empty());
    }

    #[test]
    fn advisory_signal_processes_natively_then_acks_exact_claim_binding() {
        let claim = signal_claim_response();
        let ack = serde_json::json!({
            "status":"acked","eventId":"event-1","payloadDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "decisionId":"018f47a1-7b2c-7d0a-8d11-123456789abc","acknowledgedAt":"2026-09-30T00:00:00Z","replayed":false
        });
        let fake = Arc::new(FakeTransport::with_responses(vec![
            response(200, claim.clone()),
            response(200, ack),
        ]));
        let sidecar = Arc::new(FakeSidecarTransport::default());
        let client = authenticated_signal_service(fake.clone(), sidecar.clone());
        let result = client
            .consume_advisory_signal(43123, &"B".repeat(43))
            .unwrap();
        assert_eq!(
            result,
            SignalConsumeResponse {
                status: SignalConsumeStatus::Processed
            }
        );
        let records = sidecar.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].0, 43123);
        assert_eq!(records[0].1, "B".repeat(43));
        assert_eq!(records[0].2, claim);
        drop(records);
        let requests = fake.take_requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].url,
            "https://cloud.test/v1/invest/signals/claim"
        );
        assert_eq!(requests[1].url, "https://cloud.test/v1/invest/signals/ack");
        let claim_body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        let ack_body: Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert_eq!(ack_body["eventId"], "event-1");
        assert_eq!(ack_body["payloadDigest"], claim["signal"]["payloadDigest"]);
        assert_eq!(ack_body["leaseId"], claim["lease"]["leaseId"]);
        assert_eq!(ack_body["idempotencyKey"], claim_body["idempotencyKey"]);
        assert_eq!(
            ack_body["decisionId"],
            "018f47a1-7b2c-7d0a-8d11-123456789abc"
        );
        assert_eq!(requests[0].timeout, Some(SIGNAL_REQUEST_TIMEOUT));
        assert_eq!(requests[1].timeout, Some(SIGNAL_REQUEST_TIMEOUT));
    }

    #[test]
    fn advisory_signal_rejects_invalid_claim_before_sidecar_and_ack_mismatch() {
        let bad_claim =
            serde_json::json!({"status":"claimed","lease":{},"signal":{},"private":"unexpected"});
        let sidecar = Arc::new(FakeSidecarTransport::default());
        let client = authenticated_signal_service(
            Arc::new(FakeTransport::with_responses(vec![response(
                200, bad_claim,
            )])),
            sidecar.clone(),
        );
        assert_eq!(
            client
                .consume_advisory_signal(43123, &"C".repeat(43))
                .unwrap_err(),
            "CLOUD_SIGNAL_RESPONSE_INVALID"
        );
        assert!(sidecar.records.lock().unwrap().is_empty());

        let claim = signal_claim_response();
        let mut mismatched_ack = serde_json::json!({
            "status":"acked","eventId":"other-event","payloadDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "decisionId":"018f47a1-7b2c-7d0a-8d11-123456789abc","acknowledgedAt":"2026-09-30T00:00:00Z","replayed":false
        });
        let client = authenticated_signal_service(
            Arc::new(FakeTransport::with_responses(vec![
                response(200, claim),
                response(200, mismatched_ack.clone()),
            ])),
            Arc::new(FakeSidecarTransport::default()),
        );
        mismatched_ack["eventId"] = Value::String("other-event".into());
        assert_eq!(
            client
                .consume_advisory_signal(43123, &"D".repeat(43))
                .unwrap_err(),
            "CLOUD_SIGNAL_ACK_INVALID"
        );
    }

    #[test]
    fn advisory_signal_is_fail_closed_without_origin() {
        let store = Arc::new(MemoryStore::default());
        let fake = Arc::new(FakeTransport::default());
        let client = CloudAuthService::build(
            None,
            fake.clone(),
            Arc::new(FakeSidecarTransport::default()),
            store,
        )
        .unwrap();
        assert_eq!(
            client
                .consume_advisory_signal(43123, &"E".repeat(43))
                .unwrap_err(),
            "CLOUD_ORIGIN_NOT_CONFIGURED"
        );
        assert!(fake.take_requests().is_empty());
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
    fn advisory_signal_sidecar_sender_uses_fixed_path_and_returns_only_decision_uuid() {
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
            let body = r#"{"decisionId":"018f47a1-7b2c-7d0a-8d11-123456789abc"}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        let claim = signal_claim_response();
        let decision_id = ReqwestSidecarTransport::new()
            .unwrap()
            .process_advisory_signal(port, &"f".repeat(43), &claim)
            .unwrap();
        assert_eq!(decision_id, "018f47a1-7b2c-7d0a-8d11-123456789abc");
        let request = server.join().unwrap().to_ascii_lowercase();
        assert!(request.starts_with("post /internal/native/invest/signals/consume http/1.1\r\n"));
        assert!(request.contains(&("x-xyra-native-sync-token: ".to_owned() + &"f".repeat(43))));
        assert!(request.contains(&serde_json::to_string(&claim).unwrap().to_ascii_lowercase()));
        assert!(!request.contains("authorization:"));
        assert!(!request.contains("origin:"));
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
        let persisted = store.0.lock().unwrap();
        assert_eq!(persisted.len(), 3);
        assert!(persisted.contains_key("cloud-device-id-v1"));
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
            key_algorithm: crate::cloud_crypto::DpopAlgorithm::EdDsa,
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
        client.device_key.public_identity().unwrap();
        client
            .device_key
            .save_pending_auth(&PendingAuth {
                transaction_id: "tx-9".into(),
                state: "expected-state".into(),
                nonce: "server-nonce".into(),
                verifier: "a-fake-pkce-verifier".into(),
                redirect_uri: redirect_uri.clone(),
                created_at_ms: CloudAuthService::now_ms().unwrap(),
                key_algorithm: client.device_key.current_algorithm(),
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
    fn desktop_never_refreshes_legacy_software_key_sessions_even_before_expiry() {
        for expires_at_ms in [u64::MAX, 1] {
            let store = Arc::new(MemoryStore::default());
            DeviceKey::new(store.clone())
                .store_session(&SessionTokens {
                    access_token: "legacy-access".into(),
                    refresh_token: "legacy-refresh".into(),
                    expires_at_ms,
                    sid: Some("legacy-family".into()),
                })
                .unwrap();
            store
                .set("dpop-device-key-pkcs8", "legacy-private")
                .unwrap();

            let device_key = DeviceKey::production(store.clone()).unwrap();
            let fake = Arc::new(FakeTransport::default());
            let client = CloudAuthService::build_with_device_key(
                Some("https://cloud.test".into()),
                fake.clone(),
                Arc::new(FakeSidecarTransport::default()),
                device_key,
            )
            .unwrap();

            assert_eq!(
                client.ensure_session().unwrap_err(),
                "CLOUD_REAUTH_REQUIRED"
            );
            assert!(fake.take_requests().is_empty());
            assert_eq!(
                client.device_key.stored_session_status().unwrap(),
                StoredSessionStatus::ReauthRequired
            );
            assert_eq!(store.get("dpop-device-key-pkcs8").unwrap(), None);
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
