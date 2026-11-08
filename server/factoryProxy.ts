import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

interface ProxyOptions {
  apiKey: string | undefined;
  fetcher?: typeof fetch;
}

function reply(response: ServerResponse, status: number, detail: string) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify({ status, detail }));
}

function trustedRequest(request: IncomingMessage): boolean {
  const host = request.headers.host;
  const port = request.socket.localPort;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  const site = request.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

function allowedRoute(rawUrl: string, method: string): boolean {
  // Match the raw path so encoded slashes, traversal, and extra segments cannot
  // become a more permissive upstream URL after URL normalization.
  const [path] = rawUrl.split('?');
  const list = path === '/api/v0/sessions';
  const detail = /^\/api\/v0\/sessions\/[A-Za-z0-9_-]+$/.test(path ?? '');
  const children = /^\/api\/v0\/sessions\/[A-Za-z0-9_-]+\/children$/.test(path ?? '');
  const messages = /^\/api\/v0\/sessions\/[A-Za-z0-9_-]+\/messages$/.test(path ?? '');
  if (!list && !detail && !children && !messages) return false;
  if (method !== 'GET' && !(detail && method === 'DELETE')) return false;
  const url = new URL(rawUrl, 'http://127.0.0.1');
  const seen = new Set<string>();
  for (const [name, value] of url.searchParams) {
    if (seen.has(name)) return false;
    seen.add(name);
    if ((!list && !messages) || (name !== 'limit' && name !== 'cursor')) return false;
    if (name === 'limit' && !/^(?:100|[1-9][0-9]?)$/.test(value)) return false;
    if (name === 'cursor' && (!value || value.length > 4096)) return false;
  }
  return true;
}

/** A deliberately narrow API proxy for the trusted, loopback-only Vite server. */
export function createFactoryProxy({ apiKey, fetcher = fetch }: ProxyOptions) {
  const key = apiKey?.trim();
  return async (request: IncomingMessage, response: ServerResponse, next: () => void): Promise<void> => {
    const rawUrl = request.url ?? '';
    if (!rawUrl.startsWith('/api')) {
      next();
      return;
    }
    if (!trustedRequest(request)) {
      reply(response, 403, 'The Factory proxy accepts requests from this local app only.');
      return;
    }
    if (!allowedRoute(rawUrl, request.method ?? '')) {
      reply(response, 400, 'This API route, query, or HTTP method is not allowed by the local proxy.');
      return;
    }
    if (!key) {
      reply(response, 503, 'Set FACTORY_API_KEY in the server environment, then restart the local development server.');
      return;
    }
    try {
      const upstream = await fetcher(`https://api.factory.ai${rawUrl}`, {
        method: request.method,
        // Never copy browser headers, cookies, or authorization upstream.
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        reply(response, 502, 'Factory returned an unexpected redirect. The request was not followed.');
        return;
      }
      const headers: Record<string, string> = {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-type': upstream.headers.get('content-type')?.includes('application/json')
          ? 'application/json' : 'text/plain; charset=utf-8',
      };
      const retryAfter = upstream.headers.get('retry-after');
      if (retryAfter && !retryAfter.includes(key) && (
        /^\d+$/.test(retryAfter) ||
        (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter) && Number.isFinite(Date.parse(retryAfter)))
      )) headers['retry-after'] = retryAfter;
      // Do not forward arbitrary upstream headers (including cookies/auth), and
      // redact the server credential if an upstream error happens to echo it.
      const body = upstream.status === 204 ? '' : (await upstream.text())
        .replaceAll(key, '[redacted]')
        .replaceAll(JSON.stringify(key).slice(1, -1), '[redacted]')
        .replaceAll(encodeURIComponent(key), '[redacted]');
      response.writeHead(upstream.status, headers);
      response.end(body);
    } catch {
      // Native networking errors can contain request details. Keep them out of
      // both browser responses and logs, since authorization is server-only.
      reply(response, 502, 'Could not reach Factory. Check your connection. A failed deletion may have completed; refresh before trying again.');
    }
  };
}

export function factoryProxyPlugin(apiKey: string | undefined): Plugin {
  return {
    name: 'local-factory-api-proxy',
    configureServer(server) {
      const proxy = createFactoryProxy({ apiKey });
      server.middlewares.use((request, response, next) => {
        void proxy(request, response, next);
      });
    },
  };
}
