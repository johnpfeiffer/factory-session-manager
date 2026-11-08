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
          response.end(JSON.stringify({ deleteCalls }));
          return;
        }
        if (!url.pathname.startsWith('/api/')) { next(); return; }
        const scenario = new URL(request.headers.referer ?? 'http://127.0.0.1', 'http://127.0.0.1').searchParams.get('scenario') ?? 'mixed';
        const removed = deleted.get(scenario) ?? new Set<string>();
        deleted.set(scenario, removed);
        response.setHeader('content-type', 'application/json');
        response.setHeader('cache-control', 'no-store');
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
