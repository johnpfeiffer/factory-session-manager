import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import {
  ApiError,
  deleteSessions,
  fetchAllSessions,
  filterSessions,
  isArchived,
  sessionTitle,
  type Session,
} from '../src/models/sessions.ts';

function session(sessionId: string, overrides: Partial<Session> = {}): Session {
  return { sessionId, title: `Session ${sessionId}`, status: 'idle', messageCount: 2,
    createdAt: 1, updatedAt: 2, ...overrides };
}

function page(sessions: Session[], nextCursor: string | null = null) {
  return Response.json({ sessions, pagination: { hasMore: nextCursor !== null, nextCursor } });
}

afterEach(() => mock.restoreAll());

test('search, archive filtering and updated sorting use the documented fields', () => {
  const rows = [session('alpha', { title: 'Fix Login', updatedAt: 1,
    sessionSettings: { archivedAt: '2026-11-01T00:00:00Z' } }),
  session('beta', { title: 'Login follow-up', updatedAt: 3 }),
  session('gamma', { title: '', updatedAt: 2 })];
  for (const [search, archive, sort, ids] of [
    ['LOGIN', 'archived', 'newest', ['alpha']],
    ['BETA', 'active', 'newest', ['beta']],
    ['', 'all', 'oldest', ['alpha', 'gamma', 'beta']],
    ['', 'all', 'newest', ['beta', 'gamma', 'alpha']],
  ] as const) {
    assert.deepEqual(filterSessions(rows, { search, archive, sort }).map(row => row.sessionId), ids);
  }
  assert.equal(isArchived(rows[0]!), true);
  assert.equal(isArchived(rows[1]!), false);
  assert.equal(sessionTitle(rows[2]!), 'Untitled session');
  assert.deepEqual(rows.map(row => row.sessionId), ['alpha', 'beta', 'gamma']);
});

test('all pages are fetched with an encoded cursor, de-duplicated and reported', async () => {
  const urls: string[] = [];
  const progress: number[] = [];
  mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    urls.push(url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(new Headers(options.headers).has('Authorization'), false);
    return urls.length === 1 ? page([session('a')], 'next +/?') : page([session('a'), session('b')]);
  });
  assert.deepEqual((await fetchAllSessions(undefined, n => progress.push(n))).map(row => row.sessionId), ['a', 'b']);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]!, 'http://localhost').searchParams.get('cursor'), 'next +/?');
  assert.equal(new URL(urls[0]!, 'http://localhost').searchParams.get('limit'), '100');
  assert.deepEqual(progress, [1, 2]);
});

test('broken pagination fails instead of looping or silently showing a partial list', async () => {
  mock.method(globalThis, 'fetch', async () => page([session('a')], 'repeated'));
  await assert.rejects(fetchAllSessions(), /pagination|cursor/i);
});

test('a malformed response fails clearly', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ sessions: [], pagination: { hasMore: true, nextCursor: null } }));
  await assert.rejects(fetchAllSessions(), /pagination|cursor/i);
  mock.method(globalThis, 'fetch', async () => Response.json({
    sessions: [{ ...session('a'), status: ['idle'] }],
    pagination: { hasMore: false, nextCursor: null },
  }));
  await assert.rejects(fetchAllSessions(), /invalid session/i);
});

test('HTTP failures retain actionable status and API detail', async () => {
  for (const [status, expected] of [[401, /authentication/i], [403, /permission|organization/i],
    [404, /not found/i], [429, /rate.limit/i], [500, /server/i]] as const) {
    mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'Factory explanation' }, { status }));
    await assert.rejects(fetchAllSessions(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, status);
      assert.match(error.message, expected);
      assert.match(error.message, /Factory explanation/);
      return true;
    });
    mock.restoreAll();
  }
});

test('deletion accepts 204 without parsing a body, deduplicates and caps concurrency at three', async () => {
  let active = 0;
  let maximum = 0;
  const urls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(options.method, 'DELETE');
    urls.push(url);
    active++;
    maximum = Math.max(active, maximum);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return new Response(null, { status: 204 });
  });
  const report = await deleteSessions(['a', 'b', 'a', 'c', 'd', 'e'].map(id => session(id)));
  assert.equal(maximum, 3);
  assert.equal(urls.length, 5);
  assert.equal(report.succeeded.length, 5);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.skipped, []);
});

test('rate limiting stops unscheduled deletions, respects seconds Retry-After and never retries', async () => {
  let calls = 0;
  const before = Date.now();
  mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) return Response.json({ detail: 'Slow down' }, { status: 429, headers: { 'Retry-After': '60' } });
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(null, { status: 204 });
  });
  const report = await deleteSessions(['a', 'b', 'c', 'd', 'e'].map(id => session(id)));
  assert.equal(calls, 3);
  assert.equal(report.failed.length, 1);
  assert.equal(report.succeeded.length, 2);
  assert.equal(report.skipped.length, 2);
  assert.ok(report.retryAt! >= before + 60_000);
});

test('Retry-After dates are preserved and authentication failures stop the queue', async () => {
  const retryAt = Math.ceil((Date.now() + 120_000) / 1000) * 1000;
  mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 429,
    headers: { 'Retry-After': new Date(retryAt).toUTCString() } }));
  assert.equal((await deleteSessions([session('a')])).retryAt, retryAt);
  for (const status of [401, 403]) {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => {
      calls++;
      return Response.json({ detail: 'Access denied' }, { status });
    });
    const report = await deleteSessions(['a', 'b', 'c', 'd'].map(id => session(id)));
    assert.equal(calls, 3);
    assert.equal(report.failed.length, 3);
    assert.equal(report.skipped.length, 1);
    mock.restoreAll();
  }
});

test('404 and ambiguous network failures remain failures with no automatic retry', async () => {
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) return Response.json({ detail: 'Already gone' }, { status: 404 });
    throw new TypeError('fetch failed');
  });
  const report = await deleteSessions([session('a'), session('b')]);
  assert.equal(calls, 2);
  assert.equal(report.succeeded.length, 0);
  assert.match(report.failed[0]!.error, /404/);
  assert.match(report.failed[1]!.error, /refresh|confirm|unknown/i);
});

test('an overlapping deletion operation is refused before issuing duplicate requests', async () => {
  let release!: () => void;
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    calls++;
    await new Promise<void>(resolve => { release = resolve; });
    return new Response(null, { status: 204 });
  });
  const pending = deleteSessions([session('a')]);
  await assert.rejects(deleteSessions([session('a')]), /already running/i);
  assert.equal(calls, 1);
  release();
  await pending;
});

test('a non-204 response never claims deletion succeeded', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ title: 'Unexpected response' }));
  const report = await deleteSessions([session('a')]);
  assert.deepEqual(report.succeeded, []);
  assert.equal(report.failed.length, 1);
});

test('cancelling a session load does not make any HTTP request', async () => {
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => { calls++; return page([]); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchAllSessions(controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
});
