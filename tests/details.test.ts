import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { ApiError, fetchChildSessions, fetchSessionMessages } from '../src/models/sessions.ts';
import { SessionController } from '../src/controllers/SessionController.ts';
import type { ChildSession, SessionMessage } from '../src/models/sessions.ts';

const child: ChildSession = { sessionId: 'child-1', title: 'Check login tests', status: 'idle', createdAt: 1, updatedAt: 2 };
const parent = { ...child, sessionId: 'parent-1', title: 'Login setup', messageCount: 2 };
const message: SessionMessage = { id: 'message-1', role: 'user', content: [{ type: 'text', text: 'Check the login flow.' }], createdAt: 1, updatedAt: 1 };
afterEach(() => mock.restoreAll());

test('child sessions use their documented shape without inventing message counts', async () => {
  mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, '/api/v0/sessions/parent-1/children');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(new Headers(options.headers).has('Authorization'), false);
    return Response.json({ sessions: [{ ...child, computerId: null, computer: null }] });
  });
  assert.deepEqual(await fetchChildSessions('parent-1'), [child]);
});

test('messages load one cursor page per explicit request with encoded pagination', async () => {
  const urls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    urls.push(url);
    assert.equal(options.credentials, 'omit');
    return Response.json({ messages: [message], pagination: { hasMore: urls.length === 1, nextCursor: urls.length === 1 ? 'next +/?' : null } });
  });
  const first = await fetchSessionMessages('parent-1');
  assert.deepEqual(first, { messages: [message], nextCursor: 'next +/?' });
  assert.equal(urls.length, 1, 'history must not be fetched automatically');
  await fetchSessionMessages('parent-1', first.nextCursor);
  assert.equal(new URL(urls[1], 'http://localhost').searchParams.get('cursor'), 'next +/?');
  assert.equal(new URL(urls[0], 'http://localhost').searchParams.get('limit'), '100');
});

test('detail API errors, invalid responses, and aborts remain explicit', async () => {
  for (const request of [() => fetchChildSessions('parent-1'), () => fetchSessionMessages('parent-1')]) {
    mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'Organization access denied' }, { status: 403 }));
    await assert.rejects(request(), (error: unknown) => error instanceof ApiError && error.status === 403 && /Organization access denied/.test(error.message));
    mock.method(globalThis, 'fetch', async () => Response.json({}));
    await assert.rejects(request(), /invalid/i);
  }
  mock.method(globalThis, 'fetch', async () => Response.json({ messages: [message], pagination: { hasMore: true, nextCursor: null } }));
  await assert.rejects(fetchSessionMessages('parent-1'), /cursor|pagination/i);
  const aborted = AbortSignal.abort();
  const never = mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  await assert.rejects(fetchChildSessions('parent-1', aborted));
  await assert.rejects(fetchSessionMessages('parent-1', null, aborted));
  assert.equal(never.mock.callCount(), 0);
});

test('opening details loads children only; messages require an action, paginate, and never delete', async () => {
  const cursors: (string | null)[] = [];
  let deletes = 0;
  const controller = new SessionController({
    fetchAllSessions: async () => [parent],
    fetchChildSessions: async () => [child],
    fetchSessionMessages: async (_id, cursor = null) => {
      cursors.push(cursor);
      return { messages: cursor ? [message, { ...message, id: 'message-2', role: 'assistant' }] : [message], nextCursor: cursor ? null : 'next' };
    },
    deleteSessions: async () => { deletes++; throw new Error('Unexpected DELETE'); },
  });
  await controller.load();
  await controller.openDetails(parent);
  assert.deepEqual(controller.getSnapshot().details?.children, [child]);
  assert.equal(controller.getSnapshot().details?.messages, null);
  assert.equal(cursors.length, 0);
  await controller.loadMessages();
  await controller.loadMessages(true);
  assert.deepEqual(cursors, [null, 'next']);
  assert.deepEqual(controller.getSnapshot().details?.messages?.map(item => item.id), ['message-1', 'message-2']);
  assert.equal(controller.getSnapshot().details?.nextCursor, null);
  await controller.loadMessages(true);
  assert.equal(cursors.length, 2);
  controller.closeDetails();
  assert.equal(controller.getSnapshot().details, null);
  assert.equal(controller.getSnapshot().selected.size, 0);
  assert.equal(deletes, 0);
});

test('closing or switching details aborts requests and ignores stale responses', async () => {
  let finishChildren!: (children: ChildSession[]) => void;
  let finishMessages!: (page: { messages: SessionMessage[]; nextCursor: null }) => void;
  const signals: AbortSignal[] = [];
  const controller = new SessionController({
    fetchChildSessions: async (id, signal) => {
      if (signal) signals.push(signal);
      return id === parent.sessionId ? new Promise(resolve => { finishChildren = resolve; }) : [];
    },
    fetchSessionMessages: async (_id, _cursor, signal) => {
      if (signal) signals.push(signal);
      return new Promise(resolve => { finishMessages = resolve; });
    },
  });
  const oldChildren = controller.openDetails(parent);
  const oldMessages = controller.loadMessages();
  const previousSignals = [...signals];
  assert.equal(previousSignals.length, 2);
  await controller.openDetails(child);
  // The newly opened child's request is current; only the previous two must abort.
  assert.ok(previousSignals.every(signal => signal.aborted));
  assert.equal(signals.at(-1)?.aborted, false);
  finishChildren([child]);
  finishMessages({ messages: [message], nextCursor: null });
  await Promise.all([oldChildren, oldMessages]);
  assert.equal(controller.getSnapshot().details?.session.sessionId, child.sessionId);
  assert.deepEqual(controller.getSnapshot().details?.children, []);
  assert.equal(controller.getSnapshot().details?.messages, null);
});

test('detail failures are independent and a 429 cooldown blocks duplicate or early reads', async () => {
  let now = 1000;
  let reads = 0;
  const controller = new SessionController({
    fetchChildSessions: async () => { throw new ApiError('HTTP 429: wait', 429, 5000); },
    fetchSessionMessages: async () => { reads++; return { messages: [message], nextCursor: null }; },
  }, () => now);
  await controller.openDetails(parent);
  assert.match(controller.getSnapshot().details?.childrenError ?? '', /429/);
  await controller.loadMessages();
  assert.equal(reads, 0);
  now = 5001;
  await Promise.all([controller.loadMessages(), controller.loadMessages()]);
  assert.equal(reads, 1);
  assert.equal(controller.getSnapshot().details?.messages?.length, 1);
  assert.match(controller.getSnapshot().details?.childrenError ?? '', /429/);
});

test('a repeated message cursor preserves already loaded messages and surfaces an error', async () => {
  const controller = new SessionController({
    fetchChildSessions: async () => [],
    fetchSessionMessages: async () => ({ messages: [message], nextCursor: 'repeated' }),
  });
  await controller.openDetails(parent);
  await controller.loadMessages();
  await controller.loadMessages(true);
  assert.match(controller.getSnapshot().details?.messagesError ?? '', /cursor/i);
  assert.deepEqual(controller.getSnapshot().details?.messages, [message]);
});
