# Security and verification boundaries

This is a public development repository, not a certified production release. Report suspected vulnerabilities privately to the repository owner. Do not put credentials, personal data, exploit payloads containing live tokens, or session files in issues or screenshots.

## Core boundaries

- Native secrets/device keys and privileged IPC stay outside renderer JavaScript.
- Sidecar identity, workspace and approval context are derived and validated server-side.
- Modules declare capabilities and database authority; RLS and scoped roles constrain access.
- Consequential actions require the applicable verified approval. New preview/auto-approval policy must preserve exact-input binding, revocation and audit.
- A digest detects changed content but does not establish who supplied it.
- Browser content, downloaded files and model-generated tool arguments are untrusted.
- A browser context or a process label is not a substitute for OS/VM isolation.
- Restrict migration-owner credentials to migrations; runtime credentials must remain least-privilege.

## Current limits

See [product status](docs/product-status.md). Live passkey/device flows, physical TPM behavior, R2 erasure, execution substrate, provider adapters and full release gates retain outstanding verification. No live trading is enabled. Never disable these checks to make a demo appear complete.

Secret values, broker stores, local databases and generated caches are excluded from Git. Before sharing new branches, inspect staged files and run the repository checks. Public source visibility does not certify binary releases or change third-party license terms.
