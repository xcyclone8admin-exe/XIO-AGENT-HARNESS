# Install, run, and continue XIO

These instructions describe source checkpoint `148c6a2e150e0ffd5441c76611c48e91449dd84c`. Later feature commits must update them when commands or prerequisites change. This repository preserves Git history; no reinitialization is necessary.

## Requirements

- Windows x64 for the desktop application and NSIS installer.
- Git, Node.js 22 or newer, and npm. The bundled desktop runtime is independently pinned and checksum-verified by `tools/prepare-node.mjs`.
- Current stable Rust with the MSVC x64 target. The manifest declares Rust 1.85 minimum; resolved dependencies may require a newer stable toolchain.
- Visual Studio C++ Build Tools, Windows SDK, and WebView2.
- Tauri CLI v2 for installer packaging.
- Internet access to restore dependencies and download the pinned Node runtime.

Use a short writable path such as `C:\dev\XIO-AGENT-HARNESS`. This repository is public; an authenticated account is only needed for authorized writes or GitHub features that require login.

## Clone and verify

Run in PowerShell:

```powershell
git clone https://github.com/xcyclone8admin-exe/XIO-AGENT-HARNESS.git
Set-Location XIO-AGENT-HARNESS
npm.cmd ci
npm.cmd run verify
npm.cmd run build:web
```

`npm ci` restores the exact npm workspace lockfile. `verify` generates module registries, checks TypeScript, runs ESLint and Vitest, and executes structural/boundary checks. Generated registries are intentionally not checked in. Restore dependencies before diagnosing missing workspace links; do not add ad hoc path aliases to conceal a stale installation.

The recorded successful run at this checkpoint is evidence from the original Windows development host. A clean second-machine build has not yet been certified.

## Frontend development

```powershell
npm.cmd run dev:web
```

This starts Next.js. Follow the URL it prints. Real local capabilities require the native desktop bridge and authenticated sidecar session. A browser-only page can display an unavailable state; it is not a standalone authenticated backend.

`npm.cmd run dev:sidecar` is a host-launched entry point, not a zero-configuration development server. It expects port, identity, data-directory and allowed-origin configuration, plus the private versioned stdin bootstrap. Use the native launcher or the existing test harness. Never hardcode launch tokens into the renderer or disable authentication to make a demo connect.

## Native checks and installer build

From the repository root:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --features cloud-dev
node tools/prepare-node.mjs
node apps/desktop/scripts/prepare-package.mjs
cargo install tauri-cli --version '^2' --locked
Set-Location apps/desktop/src-tauri
cargo tauri build --features cloud-dev --bundles nsis
```

Run `npm.cmd run build:web` before packaging. The preparation script builds and smoke-tests the sidecar and stages its dependencies and license resources. Tauri's build hook also invokes it.

Output is under `apps/desktop/src-tauri/target/release/bundle/nsis/`. At this checkpoint the binary and installer retain the earlier `xyra-desktop` naming. The XIO identity update belongs to the new UI/native work. Do not rename the application identifier casually: it affects installed data, credentials, and upgrade behavior.

`cloud-dev` opts into the configured development endpoint. The production origin is not configured. Inspect native origin configuration before connecting to an environment you do not control. Building without that feature does not provision a production backend.

The existing installer is unsigned. A successful same-version reinstall is recorded; a version-to-version data-preserving upgrade still needs separate evidence. Installers and source ZIPs belong in release artifacts, not normal Git history.

## Device identity and secrets

New Windows Cloud identities use the CNG Platform Crypto Provider for non-exportable P-256 keys, with no software fallback. Physical TPM operation and a real enrolled-user passkey journey remain validation items. Read [Windows Cloud device keys](../apps/desktop/docs/windows-cloud-device-key.md).

Use scoped credentials on your own machine. No API keys, refresh tokens, database passwords, broker vaults, or original user's local database are part of this repository. Runtime, migration-owner and provisioning credentials have different purposes; do not reuse the owner database URL in Worker runtime.

## Cloud development

Read [Cloud operations](../apps/cloud/PHASE2_OPERATIONS.md) and `apps/cloud/scripts/` before migrations or deployment. Local/workerd and development Wrangler configurations are separate. Apply migrations only after checking the target's ordered checksum ledger and role grants.

The original project has a no-R2 development deployment. Its health check does not prove enrollment, authenticated sync, Queue exhaustion, or blob erasure. Configure your own account/resources and inject secrets securely. R2-dependent paths remain unavailable until storage is provisioned and verified.

## Where to continue

1. Read [product status](product-status.md) and [product direction](product-direction.md).
2. Read [architecture](architecture.md), [contributing](../CONTRIBUTING.md) and [security](../SECURITY.md).
3. Work on an isolated branch, preserve migration history, and record checks against an exact commit.
4. Update status documentation when evidence changes. Rebuild the installer and final ZIP from the same finished candidate.

The original XYRA factory control plane is outside this Git repository. A clone does not require that machine's directory layout. Do not recreate its secrets or assume external absolute paths exist. The packaged runtime XYRA process is ongoing work, not supplied merely by this documentation.
