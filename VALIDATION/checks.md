# Validation

The kernel requires Red/Green TDD, passing tests, a documented local setup, and architecture plus user-journey diagrams. This checklist records validation obligations; a check is complete only when its result is recorded below.

## Automated checks

Run `npm test` and `npm run build` from the repository root using Node.js 22.18 or newer. Development checks use Node.js 26.8.1.

| Obligation | Evidence to collect |
| --- | --- |
| Cursor pagination | Mock multiple pages; verify cursor continuation, ID deduplication, and rejection of invalid or repeated cursors. |
| Session review | Verify title/ID search, archived/active filters, and both last-update sort directions. |
| Session inspection | Verify child response shape, explicit message-page requests, cursor continuation/deduplication, independent errors, and stale-response cancellation. |
| Safe deletion | Verify no more than three concurrent requests, duplicate ID prevention, 204 success, and separate successful/failed/skipped outcomes. |
| Error handling | Cover 401, 403, 404, 429, 5xx, and failed requests without automatic DELETE retries. |
| Rate limiting | Verify pending queue interruption and `Retry-After` parsing/cooldown. |
| Credential invariant | Mock the local proxy; verify server-side authorization replacement, no credential leakage in errors, and helpful missing-key behavior. |
| Proxy boundary | Verify allowlisted paths/methods and rejection of unsupported routes. |
| Build | TypeScript checking and Vite build both succeed. |

## Browser smoke checks

Use synthetic API responses without a real key or live deletion. Verify:

- A missing key produces a readable error while the interface remains usable.
- Archived sessions are shown by default; searching, filtering, sorting, counts, select-all, and clear-selection agree.
- A single-session or bulk deletion opens a dialog showing the exact affected titles and count; cancel sends no DELETE request.
- Confirming removes only successful sessions and shows failures/skipped sessions clearly.
- Repeated clicks do not launch duplicate batches; deletion controls remain disabled during operations and cooldowns.
- Refresh, loading feedback, dates, empty results, keyboard interaction, and narrow layouts remain readable.
- Double-click opens child sessions without fetching messages. Get messages and Load more retrieve explicit pages; empty histories and read errors remain clear. Checkbox double-click does not open details.

## Execution record

Validated on 2026-11-07 with Node.js 26.8.1:

- Red/Green: model, controller, and proxy test files first failed with their implementation modules absent, then passed. A malformed session-status case also failed before its parser fix. The browser reproduced an expired-cooldown bug (`Retry-After: 0` left controls disabled) before the clock update fix; afterwards Refresh and Delete re-enabled immediately.
- `npm test`: 23 tests passed (12 model, 4 controller, 7 proxy); none failed or skipped. Proxy tests use an ephemeral loopback HTTP server and mock upstream fetch.
- `npm run build`: TypeScript checking and the Vite production build passed. Vite reports a roughly 501 kB minified application chunk; this is a size advisory for the local MUI app. Only MUI's irrelevant React Server Component directive warnings are filtered; other warnings remain enabled.
- Browser: the real local server displayed the missing-key 503 and instructions to restart with the server environment configured. No real Factory key was used.
- Browser fixture (`npm run test:ui`): both cursor pages loaded seven sessions, six archived by default. Title search narrowed to one session; the active filter showed the running session, oldest-first reversed the list, select-all and clear-selection updated counts, and confirmation listed the exact titles and IDs.
- Cancelling the filtered one-session dialog sent no DELETE request, confirmed by the fixture server's request counter. The mixed six-session batch produced one success, two failures (404/429), and three unattempted sessions. Only the success disappeared; the other five stayed selected. The server recorded exactly three mixed-scenario DELETE requests with no automatic retries. Controls were disabled while requests ran.
- Individual synthetic deletion produced one success, no failures, and no unattempted sessions. The successful session disappeared and the total changed from seven to six.
- Visual checks at 1280 px and 390 px: readable desktop table and stacked narrow rows; at 390 px the document and viewport were both 390 px wide, with no horizontal overflow. The successful browser scenario had no console warnings or errors. Temporary viewport settings were reset.

No live-account deletion was performed. Kernel files were not edited by the implementation.

Session inspection validated on 2026-11-08 with Node.js 26.8.1:

- Red/Green: the new detail tests failed on the missing model exports, and the proxy inspection test failed because GET children/messages returned 400. After implementation, all 31 tests passed (the original 23 plus seven detail tests and one new proxy test). The original blocked-message-path assertion now checks blocked writes instead: read-only inspection was explicitly requested, while POST/DELETE and unsupported paths/queries must remain blocked.
- Tests cover the distinct child response shape without a fabricated message count; one message page per explicit action; encoded cursors; HTTP and malformed-response errors; deduplication; repeated cursor rejection; cooldowns; duplicate-read prevention; and aborting/ignoring old reads when details close or switch.
- Browser fixture: row double-click displayed two child sessions. Before Get messages, the request counter contained only the children GET. Get messages loaded two records, and Load more appended two more with roles and timestamps. Expandable tool input and result text were verified.
- Keyboard activation of a session title opened the panel. A session with no children/messages showed explicit empty states. Synthetic 403 responses displayed independent child/history errors. Closing restored the list; double-clicking a checkbox did not open the panel or change the final selection. The fixture recorded no DELETE requests during inspection testing.
- Desktop (1280 px) and narrow (390 px) layouts were visually checked. At 390 px, the viewport, document, drawer, and drawer content widths were all 390 px. The browser had no console warnings/errors in the successful scenario, and the temporary viewport override was reset.
- TypeScript checking and the Vite build passed. The application chunk is approximately 519 kB minified; the existing size advisory remains visible.

These checks used synthetic data. No real Factory session history was read and no live deletion was performed.

## Limits

Mock tests do not verify a user's real Factory API key, organization deletion entitlement, or upstream retention policy. An HTTP 204 response establishes successful API deletion, not permanent physical erasure. The app is a trusted local development tool; its static build is not a deployable authenticated API proxy.
