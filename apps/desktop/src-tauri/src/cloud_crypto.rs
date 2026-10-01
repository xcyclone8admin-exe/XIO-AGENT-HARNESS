//! DPoP device-key lifecycle and proof construction. Private key material and session tokens
//! stay inside the native host and are held in Windows Credential Manager via `keyring`.

use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const SERVICE: &str = "systems.xyra.agentos.cloud";
const DEVICE_KEY_ID: &str = "dpop-device-key-pkcs8";
const TPM_KEY_METADATA_ID: &str = "dpop-device-key-tpm-p256-v1";
const DEVICE_ID_ID: &str = "cloud-device-id-v1";
const SESSION_ID: &str = "cloud-session-v1";
const PENDING_AUTH_ID: &str = "cloud-auth-pending-v1";
/// Windows generic credentials cap the stored secret at 2560 bytes; keyring encodes text as
/// UTF-16, so keep one atomic session-pair value within 1280 UTF-16 code units.
const WINDOWS_CREDENTIAL_BLOB_BYTES: usize = 2560;

/// Small injectable credential store. Production uses Credential Manager; tests use an in-memory
/// store. Callers pass only logical item names, never OS keychain service names.
pub trait CredentialStore: Send + Sync {
    fn get(&self, logical_id: &str) -> Result<Option<String>, String>;
    fn set(&self, logical_id: &str, value: &str) -> Result<(), String>;
    fn delete(&self, logical_id: &str) -> Result<(), String>;
}

pub struct WindowsCredentialStore;

impl WindowsCredentialStore {
    fn entry(logical_id: &str) -> Result<keyring::Entry, String> {
        if !matches!(
            logical_id,
            DEVICE_KEY_ID | TPM_KEY_METADATA_ID | DEVICE_ID_ID | SESSION_ID | PENDING_AUTH_ID
        ) {
            return Err("CLOUD_SECRET_ID_NOT_ALLOWED".into());
        }
        keyring::Entry::new(SERVICE, logical_id).map_err(|_| "CLOUD_KEYCHAIN_UNAVAILABLE".into())
    }
}

impl CredentialStore for WindowsCredentialStore {
    fn get(&self, logical_id: &str) -> Result<Option<String>, String> {
        match Self::entry(logical_id)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("CLOUD_KEYCHAIN_UNAVAILABLE".into()),
        }
    }

    fn set(&self, logical_id: &str, value: &str) -> Result<(), String> {
        if value.encode_utf16().count() * 2 > WINDOWS_CREDENTIAL_BLOB_BYTES {
            return Err("CLOUD_KEYCHAIN_VALUE_TOO_LARGE".into());
        }
        Self::entry(logical_id)?
            .set_password(value)
            .map_err(|_| "CLOUD_KEYCHAIN_UNAVAILABLE".into())
    }

    fn delete(&self, logical_id: &str) -> Result<(), String> {
        match Self::entry(logical_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("CLOUD_KEYCHAIN_UNAVAILABLE".into()),
        }
    }
}

#[derive(Clone)]
pub struct DeviceKey {
    store: Arc<dyn CredentialStore>,
    algorithm: Arc<Mutex<DpopAlgorithm>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum DpopAlgorithm {
    #[serde(rename = "EdDSA")]
    EdDsa,
    #[serde(rename = "ES256")]
    Es256,
}

impl DpopAlgorithm {
    fn as_jws_name(self) -> &'static str {
        match self {
            Self::EdDsa => "EdDSA",
            Self::Es256 => "ES256",
        }
    }
}

impl Default for DpopAlgorithm {
    fn default() -> Self {
        Self::EdDsa
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicJwk {
    pub kty: String,
    pub crv: String,
    pub x: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub y: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DevicePublicIdentity {
    pub device_id: String,
    pub public_jwk: PublicJwk,
    pub thumbprint: String,
}

#[derive(Serialize, Deserialize)]
struct StoredSession {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at_ms: Option<u64>,
    sid: Option<String>,
    #[serde(default)]
    key_algorithm: Option<DpopAlgorithm>,
    #[serde(default)]
    reauth_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at_ms: u64,
    pub sid: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoredSessionStatus {
    SignedOut,
    Authenticated { expires_at_ms: u64 },
    ReauthRequired,
}

impl DeviceKey {
    #[cfg(test)]
    pub fn new(store: Arc<dyn CredentialStore>) -> Self {
        Self {
            store,
            // Test and compatibility constructor for previously enrolled EdDSA identities.
            algorithm: Arc::new(Mutex::new(DpopAlgorithm::EdDsa)),
        }
    }

    pub fn production(store: Arc<dyn CredentialStore>) -> Result<Self, String> {
        let algorithm = if let Some(pending) = store.get(PENDING_AUTH_ID)? {
            let pending: serde_json::Value =
                serde_json::from_str(&pending).map_err(|_| "CLOUD_AUTH_STATE_CORRUPT")?;
            match pending
                .get("key_algorithm")
                .and_then(|value| value.as_str())
            {
                Some("ES256") => DpopAlgorithm::Es256,
                Some("EdDSA") | None => DpopAlgorithm::EdDsa,
                _ => return Err("CLOUD_AUTH_STATE_CORRUPT".into()),
            }
        } else if let Some(value) = store.get(SESSION_ID)? {
            let stored: StoredSession =
                serde_json::from_str(&value).map_err(|_| "CLOUD_SESSION_CORRUPT")?;
            // Sessions written before key_algorithm was introduced were EdDSA-bound.
            stored.key_algorithm.unwrap_or(DpopAlgorithm::EdDsa)
        } else {
            DpopAlgorithm::Es256
        };
        Ok(Self {
            store,
            algorithm: Arc::new(Mutex::new(algorithm)),
        })
    }

    fn algorithm(&self) -> DpopAlgorithm {
        *self
            .algorithm
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn mark_lost_identity_reauth(&self, error: String) -> String {
        if matches!(
            error.as_str(),
            "CLOUD_TPM_KEY_LOST_REAUTH_REQUIRED" | "CLOUD_DEVICE_ID_LOST"
        ) && self.store.get(SESSION_ID).ok().flatten().is_some()
        {
            let _ = self.mark_reauth_required();
            "CLOUD_REAUTH_REQUIRED".into()
        } else {
            error
        }
    }

    pub fn current_algorithm(&self) -> DpopAlgorithm {
        self.algorithm()
    }

    fn device_id(&self) -> Result<String, String> {
        if let Some(device_id) = self.store.get(DEVICE_ID_ID)? {
            if is_uuid(&device_id) {
                return Ok(device_id);
            }
            return Err("CLOUD_DEVICE_ID_CORRUPT".into());
        }
        if self.store.get(SESSION_ID)?.is_some() || self.store.get(PENDING_AUTH_ID)?.is_some() {
            return Err("CLOUD_DEVICE_ID_LOST".into());
        }
        let mut bytes = [0u8; 16];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| "CLOUD_RANDOM_UNAVAILABLE")?;
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let device_id = format!(
            "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        );
        self.store.set(DEVICE_ID_ID, &device_id)?;
        Ok(device_id)
    }

    fn tpm_p256_public_key(&self) -> Result<(Vec<u8>, Vec<u8>), String> {
        let metadata = self.store.get(TPM_KEY_METADATA_ID)?;
        if metadata
            .as_deref()
            .is_some_and(|value| value != TPM_KEY_METADATA_VALUE)
        {
            return Err("CLOUD_TPM_KEY_METADATA_INVALID".into());
        }
        let allow_create = metadata.is_none() && self.store.get(SESSION_ID)?.is_none();
        #[cfg(windows)]
        {
            let (x, y) = cng_tpm::public_key(allow_create)?;
            if metadata.is_none() {
                self.store
                    .set(TPM_KEY_METADATA_ID, TPM_KEY_METADATA_VALUE)?;
            }
            Ok((x, y))
        }
        #[cfg(not(windows))]
        {
            let _ = allow_create;
            Err("CLOUD_TPM_UNAVAILABLE".into())
        }
    }

    fn tpm_p256_sign(&self, message: &[u8]) -> Result<Vec<u8>, String> {
        let metadata = self.store.get(TPM_KEY_METADATA_ID)?;
        if metadata.as_deref() != Some(TPM_KEY_METADATA_VALUE) {
            return Err("CLOUD_TPM_KEY_UNAVAILABLE".into());
        }
        #[cfg(windows)]
        {
            let signature = cng_tpm::sign(message)?;
            let (x, y) = self.tpm_p256_public_key()?;
            let mut point = Vec::with_capacity(65);
            point.push(0x04);
            point.extend_from_slice(&x);
            point.extend_from_slice(&y);
            ring::signature::UnparsedPublicKey::new(
                &ring::signature::ECDSA_P256_SHA256_FIXED,
                point,
            )
            .verify(message, &signature)
            .map_err(|_| "CLOUD_TPM_SIGNATURE_INVALID")?;
            Ok(signature)
        }
        #[cfg(not(windows))]
        {
            let _ = message;
            Err("CLOUD_TPM_UNAVAILABLE".into())
        }
    }

    fn private_key(&self) -> Result<Zeroizing<Vec<u8>>, String> {
        if let Some(encoded) = self.store.get(DEVICE_KEY_ID)? {
            let decoded = URL_SAFE_NO_PAD
                .decode(encoded.as_bytes())
                .map_err(|_| "CLOUD_DEVICE_KEY_CORRUPT")?;
            let private = Zeroizing::new(decoded);
            Ed25519KeyPair::from_pkcs8(private.as_slice())
                .map_err(|_| "CLOUD_DEVICE_KEY_CORRUPT")?;
            return Ok(private);
        }

        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| "CLOUD_DEVICE_KEY_GENERATION_FAILED")?;
        let private = Zeroizing::new(pkcs8.as_ref().to_vec());
        let encoded = URL_SAFE_NO_PAD.encode(private.as_slice());
        self.store.set(DEVICE_KEY_ID, &encoded)?;
        Ok(private)
    }

    fn key_pair(&self) -> Result<(Zeroizing<Vec<u8>>, Ed25519KeyPair), String> {
        let private = self.private_key()?;
        let key_pair = Ed25519KeyPair::from_pkcs8(private.as_slice())
            .map_err(|_| "CLOUD_DEVICE_KEY_CORRUPT")?;
        Ok((private, key_pair))
    }

    pub fn public_identity(&self) -> Result<DevicePublicIdentity, String> {
        let public_jwk = match self.algorithm() {
            DpopAlgorithm::EdDsa => {
                let (_private, key_pair) = self.key_pair()?;
                PublicJwk {
                    kty: "OKP".into(),
                    crv: "Ed25519".into(),
                    x: URL_SAFE_NO_PAD.encode(key_pair.public_key().as_ref()),
                    y: None,
                }
            }
            DpopAlgorithm::Es256 => {
                let (x, y) = self
                    .tpm_p256_public_key()
                    .map_err(|error| self.mark_lost_identity_reauth(error))?;
                PublicJwk {
                    kty: "EC".into(),
                    crv: "P-256".into(),
                    x: URL_SAFE_NO_PAD.encode(x),
                    y: Some(URL_SAFE_NO_PAD.encode(y)),
                }
            }
        };
        let canonical = match (&public_jwk.kty[..], &public_jwk.crv[..], &public_jwk.y) {
            ("OKP", "Ed25519", None) => format!(
                "{{\"crv\":\"Ed25519\",\"kty\":\"OKP\",\"x\":\"{}\"}}",
                public_jwk.x
            ),
            ("EC", "P-256", Some(y)) => format!(
                "{{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"{}\",\"y\":\"{}\"}}",
                public_jwk.x, y
            ),
            _ => return Err("CLOUD_DEVICE_KEY_INVALID".into()),
        };
        let thumbprint = URL_SAFE_NO_PAD.encode(ring::digest::digest(
            &ring::digest::SHA256,
            canonical.as_bytes(),
        ));
        let device_id = if self.algorithm() == DpopAlgorithm::EdDsa
            && self.store.get(DEVICE_ID_ID)?.is_none()
            && self.store.get(SESSION_ID)?.is_some()
        {
            // Preserve proofs for pre-v1 sessions, whose device id was the EdDSA thumbprint.
            thumbprint.clone()
        } else {
            self.device_id()
                .map_err(|error| self.mark_lost_identity_reauth(error))?
        };
        Ok(DevicePublicIdentity {
            device_id,
            public_jwk,
            thumbprint,
        })
    }

    pub fn sign(&self, message: &[u8]) -> Result<Vec<u8>, String> {
        match self.algorithm() {
            DpopAlgorithm::EdDsa => {
                let (_private, key_pair) = self.key_pair()?;
                Ok(key_pair.sign(message).as_ref().to_vec())
            }
            DpopAlgorithm::Es256 => self
                .tpm_p256_sign(message)
                .map_err(|error| self.mark_lost_identity_reauth(error)),
        }
    }

    pub fn dpop_proof(
        &self,
        method: &str,
        url: &str,
        token: Option<&str>,
        now_seconds: u64,
    ) -> Result<String, String> {
        let identity = self.public_identity()?;
        let url = tauri::Url::parse(url).map_err(|_| "CLOUD_DPOP_URL_INVALID")?;
        if url.scheme() != "https" || url.host_str().is_none() {
            return Err("CLOUD_DPOP_URL_INVALID".into());
        }
        let mut target = url;
        target.set_query(None);
        target.set_fragment(None);
        let mut nonce = [0u8; 16];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "CLOUD_DPOP_NONCE_FAILED")?;

        let header = serde_json::json!({
            "typ": "dpop+jwt",
            "alg": self.algorithm().as_jws_name(),
            "jwk": identity.public_jwk,
        });
        let mut claims = serde_json::Map::new();
        claims.insert("htu".into(), target.as_str().into());
        claims.insert("htm".into(), method.to_ascii_uppercase().into());
        claims.insert("iat".into(), now_seconds.into());
        claims.insert("jti".into(), URL_SAFE_NO_PAD.encode(nonce).into());
        if let Some(token) = token {
            let digest = ring::digest::digest(&ring::digest::SHA256, token.as_bytes());
            claims.insert("ath".into(), URL_SAFE_NO_PAD.encode(digest.as_ref()).into());
        }
        let encoded_header = URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&header).map_err(|_| "CLOUD_DPOP_ENCODE_FAILED")?);
        let encoded_claims = URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).map_err(|_| "CLOUD_DPOP_ENCODE_FAILED")?);
        let signing_input = format!("{encoded_header}.{encoded_claims}");
        let signature = self.sign(signing_input.as_bytes())?;
        Ok(format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature)
        ))
    }

    pub fn store_session(&self, session: &SessionTokens) -> Result<(), String> {
        let serialized = serde_json::to_string(&StoredSession {
            access_token: Some(session.access_token.clone()),
            refresh_token: Some(session.refresh_token.clone()),
            expires_at_ms: Some(session.expires_at_ms),
            sid: session.sid.clone(),
            key_algorithm: Some(self.algorithm()),
            reauth_required: false,
        })
        .map_err(|_| "CLOUD_SESSION_STORE_FAILED")?;
        if serialized.encode_utf16().count() * 2 > WINDOWS_CREDENTIAL_BLOB_BYTES {
            return Err("CLOUD_SESSION_TOO_LARGE".into());
        }
        self.store.set(SESSION_ID, &serialized)
    }

    pub fn load_session(&self) -> Result<Option<SessionTokens>, String> {
        self.store
            .get(SESSION_ID)?
            .map(|value| {
                let stored: StoredSession =
                    serde_json::from_str(&value).map_err(|_| "CLOUD_SESSION_CORRUPT")?;
                if stored.reauth_required {
                    return Err("CLOUD_REAUTH_REQUIRED".into());
                }
                Ok(SessionTokens {
                    access_token: stored.access_token.ok_or("CLOUD_SESSION_CORRUPT")?,
                    refresh_token: stored.refresh_token.ok_or("CLOUD_SESSION_CORRUPT")?,
                    expires_at_ms: stored.expires_at_ms.ok_or("CLOUD_SESSION_CORRUPT")?,
                    sid: stored.sid,
                })
            })
            .transpose()
    }

    pub fn clear_session(&self) -> Result<(), String> {
        self.store.delete(SESSION_ID)?;
        *self
            .algorithm
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = DpopAlgorithm::Es256;
        Ok(())
    }

    pub fn stored_session_status(&self) -> Result<StoredSessionStatus, String> {
        let Some(raw) = self.store.get(SESSION_ID)? else {
            return Ok(StoredSessionStatus::SignedOut);
        };
        let stored: StoredSession =
            serde_json::from_str(&raw).map_err(|_| "CLOUD_SESSION_CORRUPT")?;
        if stored.reauth_required {
            return Ok(StoredSessionStatus::ReauthRequired);
        }
        match stored.expires_at_ms {
            Some(expires_at_ms)
                if stored.access_token.is_some() && stored.refresh_token.is_some() =>
            {
                Ok(StoredSessionStatus::Authenticated { expires_at_ms })
            }
            _ => Err("CLOUD_SESSION_CORRUPT".into()),
        }
    }

    pub fn mark_reauth_required(&self) -> Result<(), String> {
        let value = serde_json::to_string(&StoredSession {
            access_token: None,
            refresh_token: None,
            expires_at_ms: None,
            sid: None,
            key_algorithm: Some(self.algorithm()),
            reauth_required: true,
        })
        .map_err(|_| "CLOUD_SESSION_STORE_FAILED")?;
        self.store.set(SESSION_ID, &value)
    }

    pub fn save_pending_auth<T: Serialize>(&self, pending: &T) -> Result<(), String> {
        let value = serde_json::to_string(pending).map_err(|_| "CLOUD_AUTH_STATE_STORE_FAILED")?;
        self.store.set(PENDING_AUTH_ID, &value)
    }

    pub fn load_pending_auth<T: for<'de> Deserialize<'de>>(&self) -> Result<Option<T>, String> {
        self.store
            .get(PENDING_AUTH_ID)?
            .map(|value| {
                serde_json::from_str(&value).map_err(|_| "CLOUD_AUTH_STATE_CORRUPT".into())
            })
            .transpose()
    }

    pub fn clear_pending_auth(&self) -> Result<(), String> {
        self.store.delete(PENDING_AUTH_ID)
    }

    pub fn rotate_session(&self, rotated: &SessionTokens) -> Result<(), String> {
        // One keychain item makes pair replacement atomic from the application's point of view.
        self.store_session(rotated)
    }
}

const TPM_KEY_METADATA_VALUE: &str =
    "v1;provider=Microsoft Platform Crypto Provider;key=systems.xyra.agentos.cloud.dpop.es256.v1;export=disabled";

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index)
                || byte.is_ascii_digit()
                || (b'a'..=b'f').contains(byte)
        })
        && matches!(bytes[14], b'4')
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

#[cfg(windows)]
mod cng_tpm {
    use ring::digest::{digest, SHA256};
    use std::sync::Mutex;
    use windows_sys::core::w;
    use windows_sys::Win32::Security::Cryptography::{
        NCryptCreatePersistedKey, NCryptExportKey, NCryptFinalizeKey, NCryptFreeObject,
        NCryptOpenKey, NCryptOpenStorageProvider, NCryptSetProperty, BCRYPT_ECCPUBLIC_BLOB,
        BCRYPT_ECDSA_PUBLIC_P256_MAGIC, MS_PLATFORM_CRYPTO_PROVIDER, NCRYPT_ALLOW_SIGNING_FLAG,
        NCRYPT_ECDSA_P256_ALGORITHM, NCRYPT_EXPORT_POLICY_PROPERTY, NCRYPT_KEY_USAGE_PROPERTY,
        NCRYPT_SILENT_FLAG,
    };

    const KEY_NAME: windows_sys::core::PCWSTR = w!("systems.xyra.agentos.cloud.dpop.es256.v1");
    const NTE_BAD_KEYSET: u32 = 0x8009_0016;
    static KEY_CREATION: Mutex<()> = Mutex::new(());

    struct NcryptObject(usize);

    impl Drop for NcryptObject {
        fn drop(&mut self) {
            if self.0 != 0 {
                unsafe { NCryptFreeObject(self.0) };
            }
        }
    }

    fn provider() -> Result<NcryptObject, String> {
        let mut handle = 0;
        let status =
            unsafe { NCryptOpenStorageProvider(&mut handle, MS_PLATFORM_CRYPTO_PROVIDER, 0) };
        if status != 0 || handle == 0 {
            return Err("CLOUD_TPM_UNAVAILABLE".into());
        }
        Ok(NcryptObject(handle))
    }

    fn open_key(provider: &NcryptObject) -> Result<NcryptObject, u32> {
        let mut handle = 0;
        let status =
            unsafe { NCryptOpenKey(provider.0, &mut handle, KEY_NAME, 0, NCRYPT_SILENT_FLAG) };
        if status != 0 || handle == 0 {
            return Err(status as u32);
        }
        Ok(NcryptObject(handle))
    }

    fn create_key(provider: &NcryptObject) -> Result<NcryptObject, String> {
        let mut handle = 0;
        let status = unsafe {
            NCryptCreatePersistedKey(
                provider.0,
                &mut handle,
                NCRYPT_ECDSA_P256_ALGORITHM,
                KEY_NAME,
                0,
                0,
            )
        };
        if status != 0 || handle == 0 {
            return Err("CLOUD_TPM_KEY_CREATE_FAILED".into());
        }
        let key = NcryptObject(handle);
        let non_exportable: u32 = 0;
        let signing_only = NCRYPT_ALLOW_SIGNING_FLAG;
        for (property, value) in [
            (NCRYPT_EXPORT_POLICY_PROPERTY, &non_exportable),
            (NCRYPT_KEY_USAGE_PROPERTY, &signing_only),
        ] {
            let status = unsafe {
                NCryptSetProperty(
                    key.0,
                    property,
                    (value as *const u32).cast(),
                    std::mem::size_of::<u32>() as u32,
                    NCRYPT_SILENT_FLAG,
                )
            };
            if status != 0 {
                return Err("CLOUD_TPM_KEY_POLICY_FAILED".into());
            }
        }
        let status = unsafe { NCryptFinalizeKey(key.0, NCRYPT_SILENT_FLAG) };
        if status != 0 {
            return Err("CLOUD_TPM_KEY_FINALIZE_FAILED".into());
        }
        Ok(key)
    }

    fn open_or_create(allow_create: bool) -> Result<(NcryptObject, NcryptObject), String> {
        let provider = provider()?;
        match open_key(&provider) {
            Ok(key) => Ok((provider, key)),
            Err(status) if status == NTE_BAD_KEYSET => {
                if !allow_create {
                    return Err("CLOUD_TPM_KEY_LOST_REAUTH_REQUIRED".into());
                }
                let _guard = KEY_CREATION
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match open_key(&provider) {
                    Ok(key) => Ok((provider, key)),
                    Err(status) if status == NTE_BAD_KEYSET => match create_key(&provider) {
                        Ok(key) => Ok((provider, key)),
                        Err(error) => match open_key(&provider) {
                            Ok(key) => Ok((provider, key)),
                            Err(_) => Err(error),
                        },
                    },
                    Err(_) => Err("CLOUD_TPM_KEY_OPEN_FAILED".into()),
                }
            }
            Err(_) => Err("CLOUD_TPM_KEY_OPEN_FAILED".into()),
        }
    }

    pub fn public_key(allow_create: bool) -> Result<(Vec<u8>, Vec<u8>), String> {
        let (_provider, key) = open_or_create(allow_create)?;
        let mut blob = [0u8; 72];
        let mut written = 0;
        let status = unsafe {
            NCryptExportKey(
                key.0,
                0,
                BCRYPT_ECCPUBLIC_BLOB,
                std::ptr::null(),
                blob.as_mut_ptr(),
                blob.len() as u32,
                &mut written,
                NCRYPT_SILENT_FLAG,
            )
        };
        if status != 0 || written != blob.len() as u32 {
            return Err("CLOUD_TPM_PUBLIC_KEY_READ_FAILED".into());
        }
        let magic = u32::from_le_bytes(blob[0..4].try_into().unwrap());
        let key_bytes = u32::from_le_bytes(blob[4..8].try_into().unwrap());
        if magic != BCRYPT_ECDSA_PUBLIC_P256_MAGIC || key_bytes != 32 {
            return Err("CLOUD_TPM_PUBLIC_KEY_INVALID".into());
        }
        Ok((blob[8..40].to_vec(), blob[40..72].to_vec()))
    }

    pub fn sign(message: &[u8]) -> Result<Vec<u8>, String> {
        let (_provider, key) = open_or_create(false)?;
        let hashed = digest(&SHA256, message);
        let mut signature = [0u8; 64];
        let mut written = 0;
        let status = unsafe {
            windows_sys::Win32::Security::Cryptography::NCryptSignHash(
                key.0,
                std::ptr::null(),
                hashed.as_ref().as_ptr(),
                hashed.as_ref().len() as u32,
                signature.as_mut_ptr(),
                signature.len() as u32,
                &mut written,
                NCRYPT_SILENT_FLAG,
            )
        };
        if status != 0 || written != signature.len() as u32 {
            return Err("CLOUD_TPM_SIGN_FAILED".into());
        }
        Ok(signature.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;
    use ring::signature::{UnparsedPublicKey, ED25519};

    #[derive(Default)]
    struct MemoryStore(Mutex<HashMap<String, String>>);

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

    #[test]
    fn device_key_persists_and_only_public_jwk_is_returned() {
        let store = Arc::new(MemoryStore::default());
        let key = DeviceKey::new(store.clone());
        let first = key.public_identity().unwrap();
        let second = DeviceKey::new(store.clone()).public_identity().unwrap();
        assert_eq!(first, second);
        assert_eq!(first.public_jwk.kty, "OKP");
        assert_eq!(first.public_jwk.crv, "Ed25519");
        assert!(!serde_json::to_string(&first).unwrap().contains("private"));
        let persisted = store.0.lock().unwrap();
        assert_eq!(persisted.len(), 2);
        assert!(persisted.contains_key(DEVICE_ID_ID));
    }

    #[test]
    fn dpop_proof_signs_htu_htm_iat_jti_and_access_hash() {
        let key = DeviceKey::new(Arc::new(MemoryStore::default()));
        let proof = key
            .dpop_proof(
                "post",
                "https://cloud.example/v1/auth/token?q=secret#fragment",
                Some("access-secret"),
                1_800_000_000,
            )
            .unwrap();
        let parts: Vec<_> = proof.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(header["alg"], "EdDSA");
        assert_eq!(claims["htu"], "https://cloud.example/v1/auth/token");
        assert_eq!(claims["htm"], "POST");
        assert_eq!(claims["iat"], 1_800_000_000u64);
        assert_eq!(
            claims["ath"],
            URL_SAFE_NO_PAD
                .encode(ring::digest::digest(&ring::digest::SHA256, b"access-secret").as_ref())
        );
        assert!(!proof.contains("access-secret"));

        let jwk: PublicJwk = serde_json::from_value(header["jwk"].clone()).unwrap();
        let signature = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        UnparsedPublicKey::new(&ED25519, URL_SAFE_NO_PAD.decode(jwk.x).unwrap())
            .verify(signing_input.as_bytes(), &signature)
            .unwrap();
    }

    #[test]
    fn session_tokens_rotate_atomically_and_logout_removes_them() {
        let store = Arc::new(MemoryStore::default());
        let key = DeviceKey::new(store.clone());
        let initial = SessionTokens {
            access_token: "access-1".into(),
            refresh_token: "refresh-1".into(),
            expires_at_ms: 100,
            sid: Some("sid-1".into()),
        };
        key.store_session(&initial).unwrap();
        assert_eq!(key.load_session().unwrap(), Some(initial));
        let rotated = SessionTokens {
            access_token: "access-2".into(),
            refresh_token: "refresh-2".into(),
            expires_at_ms: 200,
            sid: Some("sid-1".into()),
        };
        key.rotate_session(&rotated).unwrap();
        assert_eq!(key.load_session().unwrap(), Some(rotated));
        key.clear_session().unwrap();
        assert_eq!(key.load_session().unwrap(), None);
    }

    #[test]
    fn oversized_session_pair_is_rejected_without_replacing_saved_pair() {
        let store = Arc::new(MemoryStore::default());
        let key = DeviceKey::new(store.clone());
        let initial = SessionTokens {
            access_token: "access-1".into(),
            refresh_token: "refresh-1".into(),
            expires_at_ms: 10,
            sid: None,
        };
        key.store_session(&initial).unwrap();
        let too_large = SessionTokens {
            access_token: "a".repeat(1000),
            refresh_token: "r".repeat(400),
            expires_at_ms: 20,
            sid: None,
        };
        assert_eq!(
            key.store_session(&too_large).unwrap_err(),
            "CLOUD_SESSION_TOO_LARGE"
        );
        assert_eq!(key.load_session().unwrap(), Some(initial));
    }

    #[test]
    fn production_key_selection_uses_es256_for_new_and_preserves_existing_algorithm() {
        let empty = Arc::new(MemoryStore::default());
        assert_eq!(
            DeviceKey::production(empty).unwrap().current_algorithm(),
            DpopAlgorithm::Es256
        );

        let legacy = Arc::new(MemoryStore::default());
        legacy
            .set(
                SESSION_ID,
                r#"{"access_token":"a","refresh_token":"r","expires_at_ms":100,"sid":null}"#,
            )
            .unwrap();
        assert_eq!(
            DeviceKey::production(legacy).unwrap().current_algorithm(),
            DpopAlgorithm::EdDsa
        );

        let pending = Arc::new(MemoryStore::default());
        pending
            .set(PENDING_AUTH_ID, r#"{"key_algorithm":"ES256"}"#)
            .unwrap();
        assert_eq!(
            DeviceKey::production(pending).unwrap().current_algorithm(),
            DpopAlgorithm::Es256
        );
    }

    #[test]
    fn newly_allocated_device_id_is_a_stable_rfc4122_v4_uuid() {
        let store = Arc::new(MemoryStore::default());
        let key = DeviceKey::new(store.clone());
        let first = key.device_id().unwrap();
        assert!(is_uuid(&first));
        assert_eq!(first, DeviceKey::new(store).device_id().unwrap());
    }
}
