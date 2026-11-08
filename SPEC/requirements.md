# Derived requirements

Authority: [kernel manifest](../KERNEL/AGENTS.md), [INV-001](../KERNEL/INVARIANTS.md), [MVP requirements](../KERNEL/requirements-v1.md), and [design](../KERNEL/DESIGN.md). This document interprets those inputs and does not change them.

| Area | Required behavior |
| --- | --- |
| Credentials / INV-001 | Read the Factory key only from the server process environment. Do not persist it, expose it in browser code or responses, forward browser authorization, or include it in logs. |
| Local boundary | Bind Vite to `127.0.0.1`; allow only required session paths and HTTP methods. No production hosting, database, or separate backend framework. |
| Interface | React, TypeScript, Vite, native fetch, Material UI defaults, light mode, readable text, and clear loading/error feedback. |
| Listing | Fetch all documented cursor pages, deduplicate IDs, reject invalid pagination, and show total loaded sessions. Display title, ID, status, message count, created/updated dates, and archived state. |
| Review | Search title or ID, filter archived/active/all, default to archived, and sort by last update in either direction. |
| Selection | Per-session checkboxes, select all currently filtered sessions, clear selection, and visible selected count. |
| Confirmation | Show the actual session titles and count before individual or bulk deletion. Loading and selection alone never delete. |
| Queue | Use no more than three simultaneous DELETE requests, prevent overlapping operations and duplicate IDs, and never automatically retry a failed DELETE. |
| Results | Treat 204 as success, remove successes from the list, and separately report failures and skipped sessions. Clearly handle 401, 403, 404, 429, and 5xx. |
| Interruptions | Stop pending requests on 401, 403, or 429; let in-flight requests settle. Respect `Retry-After` before allowing another deletion. |
| Retention | Explain that successful API deletion is subject to Factory retention and may be restorable. Organization restrictions must appear as API errors. |
| Documentation | Explain setup, tests, environment-only credentials, and trusted local use; maintain architecture and user-journey diagrams. |

The API contract is derived from the [Factory sessions reference](https://docs.factory.com/api-reference/sessions). `sessionSettings.archivedAt` supplies archived state, and `pagination.hasMore` plus `pagination.nextCursor` govern continuation. No additional remote API fields or undocumented endpoints are assumed.

No TLA+ model is introduced. Automated checks target the credential invariant and observable application behavior; the validation checklist distinguishes recorded evidence from remaining manual checks.
