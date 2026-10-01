# Continue development

Use `development` as the integration branch; create focused feature branches or isolated worktrees. Preserve other workers' changes. Never force-push shared history or commit secret stores, generated local databases, node_modules, Rust targets or another user's sessions.

1. Read [product status](docs/product-status.md), [product direction](docs/product-direction.md), and [architecture](docs/architecture.md).
2. Restore dependencies with `npm ci` and generate the registry with `npm run gen`.
3. Keep module implementation inside its own domain. Cross-domain access uses public contracts/capabilities and host injection.
4. Add ordered additive migrations. Verify scoped keys, declared columns/defaults, RLS and manifest parity. Do not rewrite an applied migration.
5. Run meaningful focused tests for changed behavior, then the appropriate integrated checks. `npm run verify` covers typecheck, lint, tests and policy checks; desktop changes additionally need Rust checks and packaging/launch evidence.
6. Record exact candidate and commands in review evidence. Separate code correctness, local tests, live provider verification and release certification.

Use descriptive commits and pull requests. Prefer a reviewer other than the implementation author for trust boundaries and consequential workflows. A successful screenshot, page count or unit suite is not a substitute for a real connected workflow.

The external XYRA factory is optional development tooling, not a dependency installed by this repository. The portable runtime XYRA lifecycle is still being implemented; see the product direction instead of assuming external factory automation exists after clone.
