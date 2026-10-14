# Host chat/task checkpoint evidence

Behavior source: **3f6f9cdeb637f8975bd5585200ed0703864049ba**, October 14, 2026. Shared task ports are in ancestry at `3bb5108` and portable cancellation/expiry at `9286da7`. Public documentation ancestry through `b059c7c` is included. Independent security review is pending; this is implementation/verification evidence, not acceptance of the complete product.

| Command / probe | Actual result |
|---|---|
| `npm.cmd run verify` | PASS: workspace typechecks, lint, 432 tests across 66 files, checks OK on 597 files |
| `npm.cmd run build:web` | PASS: 16 registered modules, 66 static pages |
| `npm.cmd run e2e` | PASS: 3 browser workflows, including chat read → exact preview → real persisted procedure candidate → reload |
| New task-page Axe scan | Zero serious or critical WCAG2A/AA/2.1A/AA findings on the tested screen; not whole-product accessibility certification |
| `npm.cmd run build:sidecar` and `npm.cmd run smoke:bundle --workspace @xyra/sidecar` | PASS; generated host migration SQL is included in the bundled sidecar |
| `git diff --check` | PASS before commit |
| Local Ollama executable / `127.0.0.1:11434/api/tags` | No executable found on PATH; service not running. No live inference pass claimed. |

The first full test run had 431 passes and one pre-existing date-dependent positive offset fixture failure in INVEST. Commit `d36f54b` supplies an explicit September 30 clock for that assertion only. The focused three tests passed and the subsequent full verification above passed; no product schedule bounds were changed.

## Boundary coverage

- Real authenticated sidecar + PGlite migrations + actual capability handlers; the model port is a controlled deterministic fixture.
- Scope and actor ownership, app-role host mutation denial, append-only event protection, baseline upgrade and repeated migration application.
- Current registered agent-callable catalog and input validation; a non-agent-callable write is rejected even for a workspace owner.
- A read executes; the write remains uncommitted until exact confirmation. Changed input digest, stale revision, expiry and concurrent duplicate decisions reject.
- One immutable procedure candidate persists; completed admission replay and close/reopen retain the same task, action output and events without another candidate.
- Changed task scope invalidates the prior preview. Uncertain interrupted writes cannot automatically resume.

The new UI uses persisted progress polling, not token streaming or exposed hidden reasoning. Output-schema validation is not semantic verification or independent review. The unintegrated Command port at `41c2c2c` has replay/stamping findings queued for its owner; this candidate uses existing scoped bus persistence and authoritative host task results. Its older competing conductor queue is not merged or activated by this checkpoint.

The previous installer/source HANDOFF remains `cb06327`; no binary produced from this new checkpoint is being substituted for it. Remaining implementation is tracked in the complete product spec, ADDITIONS and implementation wave.
