import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionController } from '../src/controllers/SessionController.ts';
import type { DeletionReport, Session } from '../src/models/sessions.ts';

const sessions: Session[] = [
  { sessionId: 'archived-a', title: 'Old login', status: 'idle', messageCount: 2, createdAt: 1, updatedAt: 2, sessionSettings: { archivedAt: '2026-01-01' } },
  { sessionId: 'active-b', title: 'Current work', status: 'running', messageCount: 3, createdAt: 2, updatedAt: 5 },
  { sessionId: 'archived-c', title: 'Old tests', status: 'idle', messageCount: 1, createdAt: 3, updatedAt: 4, sessionSettings: { archivedAt: '2026-01-02' } },
];

test('loading, filtering, and selection never delete; select-all affects the filtered set', async () => {
  let deletes = 0;
  const controller = new SessionController({
    fetchAllSessions: async () => sessions,
    deleteSessions: async () => { deletes++; throw new Error('Unexpected deletion'); },
  });
  await controller.load();
  assert.deepEqual(controller.visibleSessions.map(s => s.sessionId), ['archived-c', 'archived-a']);
  controller.setFilters({ search: 'login' });
  controller.selectFiltered();
  assert.deepEqual([...controller.getSnapshot().selected], ['archived-a']);
  controller.requestDeleteSelected();
  assert.deepEqual(controller.getSnapshot().confirmation?.map(s => s.title), ['Old login']);
  controller.closeConfirmation();
  controller.clearSelection();
  assert.equal(controller.getSnapshot().confirmation, null);
  assert.equal(controller.getSnapshot().selected.size, 0);
  assert.equal(deletes, 0);
});

test('confirmation is required, duplicate confirmation is ignored, only successful deletions disappear', async () => {
  let finish!: (report: DeletionReport) => void;
  let deletes = 0;
  const controller = new SessionController({
    fetchAllSessions: async () => sessions,
    deleteSessions: async () => { deletes++; return new Promise(resolve => { finish = resolve; }); },
  });
  await controller.load();
  await controller.confirmDeletion();
  assert.equal(deletes, 0);
  controller.selectFiltered();
  controller.requestDeleteSelected();
  const operation = controller.confirmDeletion();
  await controller.confirmDeletion();
  controller.requestDelete(['active-b']);
  await controller.load();
  assert.equal(deletes, 1);
  assert.equal(controller.getSnapshot().deleting, true);
  finish({ succeeded: [sessions[0]], failed: [{ session: sessions[2], error: 'HTTP 403: deletion not enabled' }], skipped: [], retryAt: null });
  await operation;
  assert.deepEqual(controller.getSnapshot().sessions.map(s => s.sessionId), ['active-b', 'archived-c']);
  assert.deepEqual([...controller.getSnapshot().selected], ['archived-c']);
  assert.equal(controller.getSnapshot().report?.failed.length, 1);
  assert.equal(controller.getSnapshot().deleting, false);
});

test('a rate-limit cooldown blocks fresh deletion confirmations until Retry-After passes', async () => {
  let now = 1000;
  const controller = new SessionController({
    fetchAllSessions: async () => sessions,
    deleteSessions: async () => ({ succeeded: [], failed: [{ session: sessions[0], error: 'HTTP 429' }], skipped: [], retryAt: 5000 }),
  }, () => now);
  await controller.load();
  controller.requestDelete(['archived-a']);
  await controller.confirmDeletion();
  controller.requestDelete(['archived-c']);
  assert.equal(controller.getSnapshot().confirmation, null);
  assert.equal(controller.getSnapshot().cooldownUntil, 5000);
  now = 5001;
  controller.requestDelete(['archived-c']);
  assert.equal(controller.getSnapshot().confirmation?.length, 1);
});

test('a failed refresh preserves loaded sessions and an unexpected delete failure never implies success', async () => {
  let loads = 0;
  const controller = new SessionController({
    fetchAllSessions: async () => { if (++loads > 1) throw new Error('HTTP 503: unavailable'); return sessions; },
    deleteSessions: async () => { throw new Error('Connection lost; outcome unknown'); },
  });
  await controller.load();
  await controller.load();
  assert.equal(controller.getSnapshot().sessions.length, 3);
  assert.match(controller.getSnapshot().error ?? '', /503/);
  controller.requestDelete(['archived-a']);
  await controller.confirmDeletion();
  assert.equal(controller.getSnapshot().sessions.length, 3);
  assert.match(controller.getSnapshot().error ?? '', /outcome unknown/);
  assert.equal(controller.getSnapshot().deleting, false);
});
