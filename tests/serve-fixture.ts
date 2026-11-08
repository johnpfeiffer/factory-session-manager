// Standalone browser-test server. It never loads the real proxy or reads a Factory key.
import { createServer } from 'vite';
import type { Session } from '../src/models/sessions.ts';

const sample: Session[] = [
  'Login setup', 'Documentation follow-up', 'Session cleanup',
  'Performance notes', 'Release checklist', 'Regression tests', 'Current work',
].map((title, index) => ({
  sessionId: `synthetic-session-${index + 1}`, title, status: index === 6 ? 'running' : 'idle',
  messageCount: index + 2, createdAt: 1782164919467 + index * 3600000,
  updatedAt: 1794089503424 - index * 3600000,
  ...(index < 6 ? { sessionSettings: { archivedAt: '2026-11-01T12:00:00Z' } } : {}),
}));
const deleted = new Map<string, Set<string>>();
const deleteCalls: { scenario: string; id: string }[] = [];
const readCalls: string[] = [];

const server = await createServer({
  configFile: false,
  envPrefix: [],
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  plugins: [{
    name: 'synthetic-browser-test-api',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1:5174');
        if (url.pathname === '/__test__/state') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ deleteCalls, readCalls }));
          return;
        }
        if (!url.pathname.startsWith('/api/')) { next(); return; }
        const scenario = new URL(request.headers.referer ?? 'http://127.0.0.1', 'http://127.0.0.1').searchParams.get('scenario') ?? 'mixed';
        const removed = deleted.get(scenario) ?? new Set<string>();
        deleted.set(scenario, removed);
        response.setHeader('content-type', 'application/json');
        response.setHeader('cache-control', 'no-store');
        const inspection = /^\/api\/v0\/sessions\/(synthetic-session-\d+)\/(children|messages)$/.exec(url.pathname);
        if (request.method === 'GET' && inspection) {
          readCalls.push(request.url ?? '');
          if (scenario === 'details-error') {
            response.statusCode = 403;
            response.end(JSON.stringify({ detail: 'Synthetic organization cannot read session history.' }));
            return;
          }
          if (inspection[2] === 'children') {
            const sessions = inspection[1] === 'synthetic-session-1' ? [
              { sessionId: 'synthetic-child-1', title: 'Check login tests', status: 'idle', createdAt: 1794089503424, updatedAt: 1794089603424, computerId: null, computer: null },
              { sessionId: 'synthetic-child-2', title: 'Review the login interface', status: 'running', createdAt: 1794089603424, updatedAt: 1794089703424, computerId: null, computer: null },
            ] : [];
            setTimeout(() => response.end(JSON.stringify({ sessions })), 200);
          } else {
            const more = url.searchParams.get('cursor') === 'synthetic-message-page-2';
            const messages = inspection[1] === 'synthetic-session-2' ? [] : more ? [
              { id: 'synthetic-message-3', role: 'tool', createdAt: 1794089703424, updatedAt: 1794089703424,
                content: [{ type: 'tool_result', toolUseId: 'synthetic-tool-1', content: 'All 12 login tests passed.' }] },
              { id: 'synthetic-message-4', role: 'assistant', createdAt: 1794089803424, updatedAt: 1794089803424,
                content: [{ type: 'text', text: 'The login tests pass. The child session is reviewing the interface.' }] },
            ] : [
              { id: 'synthetic-message-1', role: 'user', createdAt: 1794089503424, updatedAt: 1794089503424,
                content: [{ type: 'text', text: 'Review the login flow and run its tests.' }] },
              { id: 'synthetic-message-2', role: 'assistant', createdAt: 1794089603424, updatedAt: 1794089603424,
                content: [{ type: 'text', text: 'I will run the login tests while the child sessions review the changes.' },
                  { type: 'tool_use', id: 'synthetic-tool-1', name: 'run_tests', input: { suite: 'login' } }] },
            ];
            const hasMore = !more && messages.length > 0;
            setTimeout(() => response.end(JSON.stringify({ messages, pagination: { hasMore, nextCursor: hasMore ? 'synthetic-message-page-2' : null } })), 200);
          }
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/v0/sessions') {
          const sessions = sample.filter(session => !removed.has(session.sessionId));
          const secondPage = url.searchParams.get('cursor') === 'synthetic-page-2';
          const body = { sessions: secondPage ? sessions.slice(3) : sessions.slice(0, 3),
            pagination: { hasMore: !secondPage, nextCursor: secondPage ? null : 'synthetic-page-2' } };
          setTimeout(() => response.end(JSON.stringify(body)), 120);
          return;
        }
        if (request.method === 'DELETE' && /^\/api\/v0\/sessions\/synthetic-session-\d+$/.test(url.pathname)) {
          const id = url.pathname.split('/').at(-1)!;
          deleteCalls.push({ scenario, id });
          const index = Number(id.split('-').at(-1));
          const rateLimited = scenario === 'ratezero' || (scenario === 'mixed' && index === 3);
          const status = rateLimited ? 429 : scenario === 'mixed' && index === 2 ? 404 : 204;
          if (rateLimited) response.setHeader('Retry-After', scenario === 'ratezero' ? '0' : '3');
          setTimeout(() => {
            response.statusCode = status;
            if (status === 204) { removed.add(id); response.end(); }
            else response.end(JSON.stringify({ status, detail: status === 429 ? 'Synthetic rate limit.' : 'Synthetic session not found.' }));
          }, rateLimited ? 0 : 500);
          return;
        }
        response.statusCode = 400;
        response.end(JSON.stringify({ detail: 'Unsupported synthetic test request.' }));
      });
    },
  }],
});
await server.listen();
server.printUrls();
const stop = async () => { await server.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
