//! DPoP device-key lifecycle and proof construction. Private key material and session tokens
//! stay inside the native host and are held in Windows Credential Manager via `keyring`.

use std::sync::Arc;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const SERVICE: &str = "systems.xyra.agentos.cloud";
const DEVICE_KEY_ID: &str = "dpop-device-key-pkcs8";
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
        if !matches!(logical_id, DEVICE_KEY_ID | SESSION_ID | PENDING_AUTH_ID) {
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicJwk {
    pub kty: String,
    pub crv: String,
    pub x: String,
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
    pub fn new(store: Arc<dyn CredentialStore>) -> Self {
        Self { store }
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
        let (_private, key_pair) = self.key_pair()?;
        let x = URL_SAFE_NO_PAD.encode(key_pair.public_key().as_ref());
        let public_jwk = PublicJwk {
            kty: "OKP".into(),
            crv: "Ed25519".into(),
            x,
        };
        let canonical = format!(
            "{{\"crv\":\"Ed25519\",\"kty\":\"OKP\",\"x\":\"{}\"}}",
            public_jwk.x
        );
        let thumbprint = URL_SAFE_NO_PAD.encode(ring::digest::digest(
            &ring::digest::SHA256,
            canonical.as_bytes(),
        ));
        Ok(DevicePublicIdentity {
            device_id: thumbprint.clone(),
            public_jwk,
            thumbprint,
        })
    }

    pub fn sign(&self, message: &[u8]) -> Result<Vec<u8>, String> {
        let (_private, key_pair) = self.key_pair()?;
        Ok(key_pair.sign(message).as_ref().to_vec())
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
            "alg": "EdDSA",
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
        self.store.delete(SESSION_ID)
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
        assert_eq!(store.0.lock().unwrap().len(), 1);
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
}
