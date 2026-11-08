# MVP Goal

UI to manage Factory.ai sessions (locally with a UI)


## Background

Factory's UI allows archiving sessions but does not appear to provide a way to delete archived sessions.

I want a small, local-only utility to list, search, filter, select, and bulk-delete sessions.

Prioritize simplicity, minimal dependencies, and functionality over appearance.

## Tech stack

Build a minimal **React + TypeScript + Vite** application for managing and deleting Factory.ai sessions through the Factory REST API.

- Native `fetch()` for HTTP requests
- Plain CSS or minimal inline styling

## Out of Scope

- No backend framework, database, authentication system, state-management library

Keep it small: Avoid unnecessary abstractions, custom hooks, and additional packages.

## Factory API

Documentation: https://docs.factory.com/api-reference/sessions

Base URL: `https://api.factory.ai`

Authentication: `Authorization: Bearer $FACTORY_API_KEY`

Relevant endpoints:

- `GET /api/v0/sessions` — list sessions
- `GET /api/v0/sessions/{sessionId}` — retrieve session details
- `DELETE /api/v0/sessions/{sessionId}` — delete a session

Read the API documentation for response schemas, pagination parameters, and deletion behavior before implementation. Do not invent API fields.

Example session:

```json
{
  "sessionId": "ce1fea7d-da89-4f2a-8012-15b3fb2d0a16",
  "title": "User login setup and guidance",
  "status": "idle",
  "createdAt": 1782164919467,
  "updatedAt": 1794089503424,
  "messageCount": 7
}
```

Timestamps are Unix milliseconds.

## Architecture

Use the Vite development server as an API proxy:

```text
Browser (React)
    |
    | /api/v0/sessions
    v
Vite dev server (localhost)
    |
    | Authorization: Bearer $FACTORY_API_KEY
    v
https://api.factory.ai
```

Requirements:

- Read `FACTORY_API_KEY` from a server-side environment variable.
- Inject the Authorization header in the Vite proxy.
- Never expose the API key through `VITE_*` environment variables or browser-side code.
- Bind the development server to `127.0.0.1`, not `0.0.0.0`.
- Proxy only the required Factory API paths.
- Avoid forwarding browser-supplied Authorization headers.
- Document that the proxy is intended for trusted local development only, not production deployment.

## UI requirements

Build a single-page session manager with:

1. **Session list**
   - Fetch all sessions using the documented cursor-based pagination.
   - Display title, session ID, status, message count, creation date, and last update.
   - Include archived state if available in the API response.
   - Show total number of loaded sessions.

2. **Filtering and sorting**
   - Search by session title or ID.
   - Filter by archived/active status where supported by the API.
   - Sort by last updated, newest or oldest first.
   - Default to displaying archived sessions if the API exposes reliable archived-state information.

3. **Selection**
   - Checkbox per session.
   - Select all currently filtered sessions.
   - Clear selection.
   - Display the number of selected sessions.

4. **Deletion**
   - Delete individual sessions.
   - Bulk-delete selected sessions.
   - Show a confirmation dialog with the number of sessions and their titles before deletion.
   - Never delete automatically on page load or selection.
   - Process deletions with bounded concurrency (maximum three simultaneous requests).
   - Treat HTTP 204 as success.
   - Handle HTTP 401, 403, 404, 429, and 5xx errors clearly.
   - Stop or back off when rate-limited; respect `Retry-After` when supplied.
   - Report successful and failed deletions separately.
   - Remove successfully deleted sessions from the displayed list.
   - Never retry failed DELETE requests automatically unless their retry behavior is explicitly safe.

5. **Safety and feedback**
   - Disable deletion while an operation is running.
   - Prevent duplicate deletion requests.
   - Show loading and error states.
   - Provide a Refresh button.
   - Explain that a successful API deletion may not mean immediate permanent erasure, depending on Factory's retention policies.
   - If deletion is unavailable for this organization, show the API error rather than implying success.




