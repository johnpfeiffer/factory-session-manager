import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createFactoryProxy } from '../server/factoryProxy.ts';

const secret = 'test-only-secret-do-not-forward';

async function withProxy(
  fetcher: typeof fetch,
  run: (base: string) => Promise<void>,
  apiKey: string | undefined = secret,
) {
  const middleware = createFactoryProxy({ apiKey, fetcher });
  const server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('proxy only forwards allowlisted session routes, methods, and pagination queries', async () => {
  let forwarded = 0;
  await withProxy(async () => {
    forwarded++;
    return new Response('{}');
  }, async (base) => {
    for (const [path, method] of [
      ['/api/v0/sessions', 'POST'],
      ['/api/v0/sessions/one', 'PATCH'],
      ['/api/v0/sessions/one/messages', 'GET'],
      ['/api/v0/other', 'GET'],
      ['/api/v0/sessions/one%2Ftwo', 'DELETE'],
      ['/api/v0/sessions?limit=101', 'GET'],
      ['/api/v0/sessions?cursor=a&cursor=b', 'GET'],
      ['/api/v0/sessions?target=https://example.com', 'GET'],
    ]) {
      const response = await fetch(base + path!, { method });
      assert.ok(response.status >= 400, `${method} ${path} was allowed`);
    }
    assert.equal(forwarded, 0);
  });
});

test('proxy injects its environment key and excludes browser credentials', async () => {
  await withProxy(async (input, options) => {
    assert.equal(input, 'https://api.factory.ai/api/v0/sessions?limit=100&cursor=next');
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${secret}`);
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('origin'), null);
    assert.equal(options?.redirect, 'manual');
    return Response.json({ sessions: [], pagination: { hasMore: false, nextCursor: null } });
  }, async (base) => {
    const response = await fetch(`${base}/api/v0/sessions?limit=100&cursor=next`, {
      headers: { authorization: 'Bearer browser-supplied', cookie: 'other=credential', origin: base },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sessions: [], pagination: { hasMore: false, nextCursor: null } });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('DELETE preserves 204 without reading a JSON body', async () => {
  await withProxy(async (_input, options) => {
    assert.equal(options?.method, 'DELETE');
    return new Response(null, { status: 204 });
  }, async (base) => {
    const response = await fetch(`${base}/api/v0/sessions/session-1`, { method: 'DELETE' });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  });
});

test('missing environment key and cross-origin requests never reach Factory', async () => {
  let forwarded = 0;
  const fetcher: typeof fetch = async () => {
    forwarded++;
    return new Response('{}');
  };
  await withProxy(fetcher, async (base) => {
    const response = await fetch(`${base}/api/v0/sessions`);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /FACTORY_API_KEY/);
  }, '');
  await withProxy(fetcher, async (base) => {
    const untrustedHeaders: Record<string, string>[] = [
      { origin: 'https://example.com' },
      { 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of untrustedHeaders) {
      const response = await fetch(`${base}/api/v0/sessions/session-1`, { method: 'DELETE', headers });
      assert.equal(response.status, 403, JSON.stringify(headers));
    }
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/api/v0/sessions/session-1`, {
        method: 'DELETE', headers: { host: 'attacker.example' },
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(status, 403);
  });
  assert.equal(forwarded, 0);
});

test('API errors retain status and Retry-After while withholding response credentials', async () => {
  await withProxy(async () => new Response(JSON.stringify({ detail: `Denied ${secret}` }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '30', 'set-cookie': 'private=value', authorization: secret },
  }), async (base) => {
    const response = await fetch(`${base}/api/v0/sessions/session-1`, { method: 'DELETE' });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '30');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('authorization'), null);
    const body = await response.text();
    assert.ok(!body.includes(secret));
    assert.match(body, /Denied/);
  });
});

test('network failures and redirects produce sanitized errors without exposing credentials', async () => {
  for (const fetcher of [
    async () => { throw new Error(`Network error with ${secret}`); },
    async () => new Response(null, { status: 302, headers: { location: 'https://example.com' } }),
  ]) {
    await withProxy(fetcher, async (base) => {
      const response = await fetch(`${base}/api/v0/sessions`);
      assert.equal(response.status, 502);
      assert.ok(!(await response.text()).includes(secret));
      assert.equal(response.headers.get('location'), null);
    });
  }
});

test('a reflected credential cannot leak through Retry-After', async () => {
  await withProxy(async () => new Response('{}', {
    status: 429, headers: { 'retry-after': secret },
  }), async (base) => {
    const response = await fetch(`${base}/api/v0/sessions`);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), null);
  });
});
