# Factory session manager

A small, local utility for reviewing and deleting Factory.ai sessions. React, TypeScript, Vite, and Material UI provide a single-page interface; the Vite development server forwards a narrow set of requests to Factory.

The application lists all available sessions, searches titles and IDs, filters archived or active sessions, sorts by last update, and deletes individual or selected sessions after confirmation. It starts with archived sessions selected in the filter. Successful deletions disappear from the list; failures and sessions skipped after an interrupted batch remain available for review.

## Run locally

Use Node.js 22.18 or newer and npm. Development checks use Node.js 26.8.1.

```sh
npm install
```

In **zsh**, start the server in a subshell and enter the key at the hidden prompt:

```zsh
(
  read -rs 'FACTORY_API_KEY?Factory API key: '
  printf '\n'
  export FACTORY_API_KEY
  npm run dev
)
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Stop the server with Ctrl+C; exiting the subshell discards its environment variable. Do not paste a key into a shell command, source file, `.env` file, browser field, or `VITE_*` variable. The key is read from the server process environment, used for upstream authorization, and never persisted or sent to the browser.

The UI can start without a key. API requests then return a helpful configuration error; restart the development server with a key to connect. Factory must enable session deletion for your organization. A 403 or other API error is displayed as a failure.

This proxy is for trusted local development only. It binds to `127.0.0.1`; do not expose it through a tunnel, bind it to a public interface, or deploy it as a production service. The static build does not include an API server, and Vite preview is not a supported way to use the session manager.

## Inspecting sessions

Double-click a session row, or choose its title with the mouse or keyboard, to open the details panel on the right. Its child sessions load automatically, with their titles, IDs, status, and creation/update times. Closing the panel cancels pending reads and clears its message history from application state.

Choose **Get messages** to load the first page of the selected session's history. **Load more messages** fetches the next page; **Refresh messages** starts again from the first page. Messages show their role, timestamp, text, and expandable tool calls/results. Images, binary documents, and reasoning blocks appear as labeled placeholders. Text documents display their text. Child-session and message errors appear separately, and rate-limit delays apply to these reads as well as deletion. Inspection does not select or delete sessions.

## Deleting sessions

Review the archived filter, search results, and selected count. “Select all filtered” adds the currently visible sessions to the selection. Clearing the selection removes all selected IDs. Deleting a session or a selection opens a confirmation dialog listing the affected titles and count. Selecting or loading sessions never initiates deletion.

At most three deletion requests run simultaneously. The app prevents overlapping deletion operations and duplicate IDs within a batch. A rate limit stops new requests and blocks another deletion until the `Retry-After` delay expires when the server supplies one. Authentication or authorization failures also stop the pending queue. Requests already in flight can still finish. Failed DELETE requests are never retried automatically; review the reported successful, failed, and skipped sessions before taking further action.

Factory documents deletion as a soft delete that may be restored during its retention period. A successful API response does **not** imply immediate permanent erasure. See the [Factory sessions API documentation](https://docs.factory.com/api-reference/sessions) for availability and retention details.

## Check locally

```sh
npm test
npm run build
```

Tests use Node's built-in test runner with synthetic session data and mock upstream responses. They do not require a Factory key and do not delete real sessions. The build runs TypeScript checking and produces static assets in `dist/`.

For an interactive smoke check without a key or Factory account:

```sh
npm run test:ui
```

Open [http://127.0.0.1:5174](http://127.0.0.1:5174). This separate server uses seven synthetic sessions and two cursor pages; it never loads the real proxy. The default scenario gives mixed deletion results (204, 404, and 429) and stops the remaining queue. Use `/?scenario=success` for successful deletions or `/?scenario=ratezero` for `Retry-After: 0`. Successful deletions remain removed until the fixture server restarts. Stop it with Ctrl+C. The normal development server can also be started without a key to check the configuration error. Live-account deletion is excluded from all validation.

For inspection checks, open **Login setup** to see two child sessions and two pages of messages, including tool calls and results. **Documentation follow-up** has no children or messages. Use `/?scenario=details-error` to check organization-access errors in both parts of the panel.

See [architecture.md](architecture.md), the derived [requirements](SPEC/requirements.md), and the [validation checklist](VALIDATION/checks.md). The human-authored [kernel](KERNEL/AGENTS.md) remains the authority for this project.
