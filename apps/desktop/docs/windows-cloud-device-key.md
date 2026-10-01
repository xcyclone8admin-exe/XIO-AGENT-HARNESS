# Windows Cloud device key

New Windows Cloud identities use the Microsoft Platform Crypto Provider (MPCP) with a persisted
ECDSA P-256 key named `systems.xyra.agentos.cloud.dpop.es256.v1`. The provider is the Windows CNG
TPM provider; creation fails closed if it is unavailable or cannot create/finalize the requested
key. There is no exportable software-key fallback.

The desktop creates the key through `NCryptCreatePersistedKey`, sets
`NCRYPT_EXPORT_POLICY_PROPERTY` to zero (no private-key export) and
`NCRYPT_KEY_USAGE_PROPERTY` to `NCRYPT_ALLOW_SIGNING_FLAG`, then finalizes it. It retains CNG
provider/key handles only for the duration of an operation and frees both through
`NCryptFreeObject`. Public identity comes from the `BCRYPT_ECCPUBLIC_BLOB`; only its big-endian
32-byte X and Y coordinates leave CNG. Credential Manager stores a fixed metadata marker, a
separate stable device UUID and the session pair. It stores no P-256 private key bytes.

The Cloud public JWK is exactly `{kty:"EC",crv:"P-256",x,y}` with canonical unpadded base64url
coordinates. Its RFC 7638 thumbprint hashes the canonical UTF-8 member order
`{"crv":"P-256","kty":"EC","x":"...","y":"..."}`. `device_id` is a persisted random
UUID and is independent of the thumbprint. DPoP uses `alg:"ES256"`; CNG signs the SHA-256 digest
of the JWS signing input and returns the 64-byte raw P1363 `r||s` signature expected by JOSE.

Existing sessions without an algorithm marker are treated as EdDSA-bound to preserve compatibility.
New sessions use ES256. A refresh keeps the session's recorded algorithm. Logout clears the session
but leaves the device key and device UUID in place. The key is never silently replaced. If key
metadata exists but the CNG key is missing, the session is marked reauthentication-required; user
reenrollment creates a new identity. A device reset or TPM replacement therefore requires fresh
passkey authentication, and any old server refresh family can only be revoked if its refresh token
is still usable before the reset.

The CNG path was compiled with the Windows target and its surrounding Rust tests exercise algorithm
selection and device-ID persistence. This checkout has not certified that a physical TPM is present,
that firmware policy allows the operation, or that an enterprise TPM policy accepts the key. Such a
machine must fail closed with the provider/key error; it must not switch providers. Cloud origin
registry entries remain unset until a dev Worker origin and identity are verified.
