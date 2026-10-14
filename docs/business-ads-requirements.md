# Business, advertising, websites, funnels and email: continuation requirements

Recorded October 14, 2026. **Approved product direction; implementation and acceptance remain pending.** This supplements [ADDITIONS.md](../ADDITIONS.md). The frozen continuation installer and source remain `cb0632727fc3422ec63a8773d20bfaa974d20c34`; this document does not change their functionality.

## User intent and reference products

The user requires XIO to form, organize and manage a business, connect external website/MCP tools, and provide a chat-based agent workspace. They explicitly added Meta Ads and Google Ads and requested quality comparable to MadeThis and Polsia. They also named **Emergent specifically as the benchmark for website, funnel and email building**. The intended outcome is one connected business operating loop with previews, user-controlled autonomy, durable progress and real results.

Public reference material checked on October 14, 2026:

- [MadeThis](https://www.madethis.com/) advertises business creation and ongoing operations spanning websites, payments, advertising, email and support, with task approval and iterative feedback.
- [Polsia's product explanation](https://polsia.com/blog/hire-app-developer) describes coordinated planning, product development, Meta advertising, outreach and customer operations.
- [Emergent's landing-page builder](https://emergent.sh/ai-landing-page-builder) describes prompt-built pages with database-backed forms, domain publishing and connected analytics, CRM/email and checkout/booking. Its [email-marketing builder page](https://emergent.sh/ai-website-builder/email-marketing) provides a further reference for connected email-program websites. These descriptions inform the benchmark; the requirements below are XIO's explicit acceptance targets, not a claim that every listed capability was tested in Emergent.

These are vendor-described benchmarks, not independently tested evidence of reliability or performance. XIO has not achieved parity. Do not infer that either reference supports Google Ads from these sources; Google Ads is the user's explicit XIO requirement. Do not copy proprietary code, artwork, pricing, shared-account arrangements or marketing claims.

## Required business workflows

Each row is a new acceptance target, not a completed requirement. Link implementation, exact-candidate tests and provider evidence before changing its disposition.

| ID | Required workflow | Acceptance evidence |
|---|---|---|
| XIO-ADD-BIZ-001 | Start a new business or onboard an existing one from conversation: business profile, offering, customers, brand, goals, team roles, budgets and operating plan. | Chat creates persistent, scoped records and actionable projects after the applicable previews; the user can edit and resume them after restart. |
| XIO-ADD-BIZ-002 | Organize work across people and agents: ownership, dependencies, recurring tasks, SOPs, approvals, documents and progress. | A real delegated task updates its project and evidence, supports steering/cancel/resume, and reports failures without claiming success. |
| XIO-ADD-BIZ-003 | Connect product/site creation, CRM, sales pipeline, customer messages/support, billing/accounting records and KPI reviews. | Trace one customer journey from campaign/landing page to CRM, authorized follow-up and financial reporting using configured services; preserve source IDs and attribution. |
| XIO-ADD-BIZ-004 | Support business formation preparation and administration: entity/ownership records, document drafts, filing checklist and external-service handoff. | Distinguish prepared, submitted, accepted and rejected records. External filings, banking/KYC and signatures use supported authorized providers or explicit human completion with receipts; a generated document never counts as legal formation. |
| XIO-ADD-CON-001 | Discover, configure and use external API/MCP tools from chat. | Secure connection onboarding, tool discovery/schema validation, scoped invocation, progress/result evidence, revoked-access refusal and cross-business isolation. A connector catalog alone fails acceptance. |

Reuse Command/SWARM for chat and bounded work, Corporate/Ops for administration, Growth/Comms for customers and marketing, Studio for assets, MONEY for financial records, FLOW for durable scheduling, CONNECT for integrations, and BRAIN/Data/Intel for knowledge and measurement. Determine actual public ports and missing host wiring from source; this allocation is not a claim that those integrations exist.

## Meta Ads and Google Ads

Implement both provider adapters through official supported APIs or a separately verified MCP adapter. Browser automation is a distinct fallback with visible sessions and the same authorization policy, never a way around provider access restrictions.

| ID | Required behavior | Acceptance evidence |
|---|---|---|
| XIO-ADD-ADS-001 | Connect user-authorized Meta business/ad accounts and Google Ads customer/manager accounts; select the exact business/account, currency and timezone. | OAuth/access renewal, least-scope permissions, account discovery, disconnect/revocation and account-mismatch tests. Secrets remain in native/server broker storage. |
| XIO-ADD-ADS-002 | Meta Facebook/Instagram campaigns: objectives, campaign/ad-set/ad structure, eligible audiences/placements, schedules, creatives and budgets; read, draft, create, edit, pause and resume. | Preview the actual resolved payload, create a paused campaign where supported, read it back by provider ID, handle review/rejection, and prove approved activation and verified pause. |
| XIO-ADD-ADS-003 | Google Ads campaigns: Search keywords/negative keywords, ad groups, ads/assets, targeting, bid/budget configuration and schedules; read, draft, create, edit, pause and resume. | Equivalent paused-create/read-back/activation/pause journey. Keep Display, YouTube and Performance Max as explicit channel extensions with their own tested support; a Search adapter does not prove all campaign types. |
| XIO-ADD-ADS-004 | Prepare landing pages, ad copy and image/video variations, reusable brand assets and experiments. | Render the proposed creative/landing destination, show asset provenance and required fields, validate provider constraints, and invalidate approval when content changes. |
| XIO-ADD-ADS-005 | Conversion/event setup and reporting: spend, impressions, clicks, conversions, CPA and ROAS, linked to CRM and financial records where supported. | Preserve account/currency/timezone/date range, attribution window, data freshness and provider IDs. Show missing/unavailable data honestly; deduplicate events and never sum incompatible attribution into invented revenue. |
| XIO-ADD-ADS-006 | Recommend and execute bounded optimization: bids, targeting, creatives and budget allocation. | The recommendation states evidence, uncertainty and proposed changes; execution requires exact preview approval or a valid scoped auto-approval grant. Provider read-back confirms the actual change. |
| XIO-ADD-ADS-007 | Control spend and stop campaigns. | Persist per-account/campaign limits, currency, interval/timezone, authorization expiry and aggregate automation limits. Test concurrent workers, stale spend data, restart, revoke and emergency pause. Stop further activation/increases when authority or spend state is unknown. |

Provider billing and reporting can lag. Separate XIO's authorization ceiling, provider-enforced limits, reported spend and estimated in-flight exposure. Document what the provider actually enforces; a polling job is not proof of a guaranteed real-time hard cap. Optimization cannot silently raise the approved ceiling. No test ad spend or account budget is assumed from a developer's general approval.

Marketing automation must distinguish pending, paused, under review, active, rejected, failed and unknown outcomes. Persist intent and provider identifiers before retries; on timeout reconcile remote state before recreating an object. Exactly-once claims require provider-supported idempotency or proven reconciliation. An API request being accepted does not mean an ad is serving or producing results.

## Website, funnel and email builder

Emergent is the requested quality reference for this building experience. XIO must create editable, deployable outputs and connected workflows from chat, preserving brand assets and business context. Saving generated HTML or showing a mockup alone does not complete a funnel or an email integration.

| ID | Required behavior | Acceptance evidence |
|---|---|---|
| XIO-ADD-WEB-001 | Build and revise responsive websites and landing pages through chat and contextual editing, with reusable sections, brand assets, mobile/desktop previews and owned source export. | Prompt -> editable preview -> targeted revision -> approved deployment on a configured domain -> verified published page. Test keyboard navigation, responsive layout, form behavior, version history and rollback; do not silently publish drafts. |
| XIO-ADD-FUN-001 | Build connected multistep funnels: opt-in/lead magnet, lead qualification, booking or checkout, optional upsell and thank-you/follow-up routes. | A visitor completes a real configured test flow with persisted lead/customer state, validated forms, CRM routing, deduplication and visible failure recovery. Test payments in the provider's test mode; a preview never charges a customer. |
| XIO-ADD-FUN-002 | Measure and improve funnels with versioned variants, source/UTM tracking, step conversion and drop-off reporting. | Trace an authorized test visitor through the full funnel, preserve attribution and event IDs, deduplicate retries and report denominators/date ranges. Do not declare a statistically supported winner without sufficient evidence or invent missing conversions. |
| XIO-ADD-EMAIL-001 | Build branded responsive email templates and campaigns from chat: subject, preheader, content blocks, images, links, personalization and plain-text fallback. | Render and edit the exact proposed email, validate links and missing personalization, inspect representative desktop/mobile email-client rendering and export the template. Website CSS rendering alone does not prove email-client compatibility. |
| XIO-ADD-EMAIL-002 | Create and manage welcome/nurture, onboarding, transactional and re-engagement sequences with segments, triggers, delays and branches through FLOW/Growth/Comms. | A consented test signup triggers the intended sequence once, updates CRM, supports pause/edit/resume and survives restart. Verify suppression after unsubscribe, bounce or complaint and safe behavior when a provider reply is lost. |
| XIO-ADD-EMAIL-003 | Connect a configured email delivery provider with verified sender/domain, secure credentials, scheduling and delivery-event reporting. | Distinguish draft, approved, scheduled, submitted, delivered, bounced and failed states using provider evidence. Preview content, sender, recipients/segment version, timing and send limits before approval; verify a test delivery to an authorized inbox. Suppression lists remain enforced in automatic mode. |

Keep the workflow connected: **Meta/Google campaign -> landing page -> consented capture -> CRM -> email follow-up -> booking/checkout -> measured outcome**. Preview each public or recipient-facing change; edits to approved content, audience or schedule invalidate the affected approval. Domain setup and email sender authentication need explicit provider evidence, not a green UI toggle. Track opens/clicks with their measurement limitations and do not equate them with confirmed sales.

## Chat, approval and execution contract

User flow: describe the business goal -> XYRA context/plan -> resolve account and tools -> generate campaign/operational preview -> approve or evaluate scoped auto-approval -> execute -> verify -> report and checkpoint.

- Show affected business/account, content/diff, audience, schedule, currency, budget and expected effects before mutation. Unsupported simulations must be labeled.
- Bind approval to the exact version/digest and scope. Revisions require a new decision. Auto-approval is explicit, bounded, durable and revocable; it does not create provider permissions.
- Treat model output, websites and MCP responses as untrusted data. The capability bus, provider adapter and budget policy enforce authorization independently of model text.
- Connect tools through public contracts and injected host services. Keep audit records, pause/cancel acknowledgements, retry state and human takeover visible in the existing overarching spaces.

## Completion and benchmark rubric

Run the same recorded briefs against XIO and, when access is available, the named reference products. Record product version/date, configured accounts, inputs, allowed spend and actual results. Without reference access, label comparison vendor-described and do not claim parity.

Required XIO journeys:

1. **Business launch:** a conversation produces persistent business records, a usable project/operating plan, a previewed landing page and connected CRM/customer workflow.
2. **Meta campaign:** connect an authorized test account, preview/create paused assets, verify provider state, exercise approved lifecycle changes and reconcile reporting.
3. **Google campaign:** independently complete the same lifecycle with Google's object model; both integrations must pass.
4. **Daily operation:** a scheduled run reads results, proposes a justified change, respects budget/approval policy, and writes a traceable business update.
5. **Recovery/control:** revise during work, revoke a connector or approval, hit quota, simulate lost replies and restart. No duplicate campaign, unapproved activation, false success or cross-business access is permitted.
6. **Website/funnel/email build:** build and revise a responsive page from chat, publish an approved version, complete a consented test signup, confirm its CRM record and one real authorized test email, then verify booking/test checkout and attribution. Change a funnel/email version, invalidate stale approval, pause a sequence and demonstrate rollback/restart recovery. Score editing and preview usability as well as connected execution against the Emergent reference.

Evaluate task completion, correctness, practical usefulness, time, human interventions, cost, recoverability, transparency and accessibility. Publish measurements rather than an unsupported "as good as" claim. Mock/fixture tests prove local behavior only; real read-back is required for provider integration acceptance. Paid delivery evidence requires an explicitly configured bounded account budget; keep missing external prerequisites separate from code work.

## Provider implementation references and prerequisites

- [Meta Marketing API SDK](https://github.com/facebook/facebook-python-business-sdk): official SDK reference. Verify the selected API version, app review/access tier, permissions and ad-account roles before implementing; record approved capabilities per account.
- [Google Ads API introduction](https://developers.google.com/google-ads/api/docs/get-started/introduction) and [access-management migration](https://developers.google.com/google-ads/api/docs/api-policy/developer-token): current documentation describes access associated with Google Cloud projects following the September 2026 developer-token change. Recheck the chosen API version's actual onboarding and OAuth requirements; do not blindly copy older token setup recipes.

Required external inputs include authorized provider accounts/apps, sufficient access, secure bindings, conversion destinations and configured budgets. Missing credentials do not prevent implementation and deterministic testing, but they do prevent claiming live acceptance. The existing frozen installer contains none of the new connector functionality described here. Preserve PAPER-only INVEST; ad operations are separate from investment trading.
