export interface Session {
  sessionId: string;
  title?: string;
  status: 'idle' | 'pending' | 'running';
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  sessionSettings?: { archivedAt?: string };
}

export type SessionSummary = Pick<Session, 'sessionId' | 'title' | 'status' | 'createdAt' | 'updatedAt'>;
export type ChildSession = SessionSummary & { title: string };
export interface MessageContent { type: string; [field: string]: unknown }
export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: MessageContent[];
  createdAt: number;
  updatedAt: number;
}
export interface MessagePage { messages: SessionMessage[]; nextCursor: string | null }

export interface SessionFilters {
  search: string;
  archive: 'archived' | 'active' | 'all';
  sort: 'newest' | 'oldest';
}

export interface DeletionReport {
  succeeded: Session[];
  failed: { session: Session; error: string }[];
  skipped: Session[];
  retryAt: number | null;
}

export class ApiError extends Error {
  status: number;
  retryAt: number | null;

  constructor(message: string, status: number, retryAt: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAt = retryAt;
  }
}

const basePath = '/api/v0/sessions';

export function isArchived(session: Session): boolean {
  return Boolean(session.sessionSettings?.archivedAt);
}

export function sessionTitle(session: { title?: string }): string {
  return session.title?.trim() || 'Untitled session';
}

export function filterSessions(sessions: Session[], filters: SessionFilters): Session[] {
  const search = filters.search.trim().toLocaleLowerCase();
  return sessions.filter(session => {
    const matchesArchive = filters.archive === 'all' ||
      isArchived(session) === (filters.archive === 'archived');
    return matchesArchive && (!search || sessionTitle(session).toLocaleLowerCase().includes(search) ||
      session.sessionId.toLocaleLowerCase().includes(search));
  }).sort((a, b) => filters.sort === 'newest' ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readSummary(value: unknown): SessionSummary {
  if (!record(value) || typeof value.sessionId !== 'string' || !value.sessionId ||
    typeof value.status !== 'string' || !['idle', 'pending', 'running'].includes(value.status) ||
    typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) ||
    typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) {
    throw new Error('Factory returned an invalid session response. Refresh to try loading again.');
  }
  // Keep only the documented fields used by this utility; never persist API responses.
  return {
    sessionId: value.sessionId,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    status: value.status as Session['status'],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function readSession(value: unknown): Session {
  const summary = readSummary(value);
  if (!record(value) || typeof value.messageCount !== 'number' || !Number.isFinite(value.messageCount)) {
    throw new Error('Factory returned an invalid session response. Refresh to try loading again.');
  }
  return {
    ...summary,
    messageCount: value.messageCount,
    ...(record(value.sessionSettings) && typeof value.sessionSettings.archivedAt === 'string'
      ? { sessionSettings: { archivedAt: value.sessionSettings.archivedAt } } : {}),
  };
}

async function requestJson(path: string, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(path, { signal, credentials: 'omit', cache: 'no-store' });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Cannot reach the local Factory proxy. Check that the development server is running and try again.');
  }
  if (!response.ok) throw await responseError(response);
  try { return await response.json(); }
  catch { throw new Error('Factory returned an unreadable API response. Try again.'); }
}

function readNextCursor(body: Record<string, unknown>): string | null {
  const page = body.pagination;
  if (!record(page) || typeof page.hasMore !== 'boolean' ||
    !(page.nextCursor === null || typeof page.nextCursor === 'string') ||
    (page.hasMore && !page.nextCursor)) {
    throw new Error('Factory returned an invalid pagination cursor.');
  }
  return page.hasMore ? page.nextCursor as string : null;
}

export async function fetchChildSessions(sessionId: string, signal?: AbortSignal): Promise<ChildSession[]> {
  const body = await requestJson(`${basePath}/${encodeURIComponent(sessionId)}/children`, signal);
  if (!record(body) || !Array.isArray(body.sessions)) throw new Error('Factory returned an invalid child session response.');
  return body.sessions.map(value => {
    const summary = readSummary(value);
    if (!record(value) || typeof value.title !== 'string') throw new Error('Factory returned an invalid child session title.');
    return { ...summary, title: value.title };
  });
}

export async function fetchSessionMessages(
  sessionId: string, cursor: string | null = null, signal?: AbortSignal,
): Promise<MessagePage> {
  const query = new URLSearchParams({ limit: '100' });
  if (cursor !== null) query.set('cursor', cursor);
  const body = await requestJson(`${basePath}/${encodeURIComponent(sessionId)}/messages?${query}`, signal);
  if (!record(body) || !Array.isArray(body.messages)) throw new Error('Factory returned an invalid message response.');
  const messages = body.messages.map((value): SessionMessage => {
    if (!record(value) || typeof value.id !== 'string' || !value.id ||
      typeof value.role !== 'string' || !['user', 'assistant', 'tool', 'system'].includes(value.role) ||
      typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) ||
      typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) ||
      !Array.isArray(value.content) || !value.content.every(block => record(block) && typeof block.type === 'string')) {
      throw new Error('Factory returned an invalid message response.');
    }
    return { id: value.id, role: value.role as SessionMessage['role'],
      content: value.content as MessageContent[], createdAt: value.createdAt, updatedAt: value.updatedAt };
  });
  return { messages, nextCursor: readNextCursor(body) };
}

function retryTime(response: Response): number | null {
  if (response.status !== 429) return null;
  const value = response.headers.get('Retry-After')?.trim();
  const now = Date.now();
  if (value && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(now + Number(value) * 1000)) {
    return now + Number(value) * 1000;
  }
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(now, date) : now + 30_000;
}

async function responseError(response: Response, retryAt = retryTime(response)): Promise<ApiError> {
  const explanations: Record<number, string> = {
    401: 'Authentication failed. Check FACTORY_API_KEY in the local server environment.',
    403: 'Permission denied. This API may not be enabled for your organization.',
    404: 'Session not found. Refresh to check whether it still exists.',
    429: 'Factory rate limit reached. Requests have stopped; wait before trying again.',
  };
  let detail = '';
  try {
    const body: unknown = await response.json();
    if (record(body)) detail = typeof body.detail === 'string' ? body.detail :
      typeof body.title === 'string' ? body.title : '';
  } catch { /* A missing or non-JSON error body must not hide the HTTP error. */ }
  const explanation = explanations[response.status] || (response.status >= 500
    ? 'Factory or the local proxy returned a server error. Try refreshing later.'
    : 'Factory returned an unexpected response; the operation could not be confirmed.');
  return new ApiError(`HTTP ${response.status}: ${explanation}${detail ? ` ${detail}` : ''}`,
    response.status, retryAt);
}

export async function fetchAllSessions(
  signal?: AbortSignal,
  onProgress?: (count: number) => void,
): Promise<Session[]> {
  const sessions = new Map<string, Session>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor !== null) query.set('cursor', cursor);
    const body = await requestJson(`${basePath}?${query}`, signal);
    if (!record(body) || !Array.isArray(body.sessions)) {
      throw new Error('Factory returned an invalid session pagination response.');
    }
    const nextCursor = readNextCursor(body);
    for (const value of body.sessions) {
      const session = readSession(value);
      sessions.set(session.sessionId, session);
    }
    onProgress?.(sessions.size);
    if (nextCursor === null) break;
    cursor = nextCursor;
    if (!cursor || cursors.has(cursor)) {
      throw new Error('Factory returned a missing or repeated pagination cursor. Refresh to load sessions again.');
    }
    cursors.add(cursor);
  } while (cursor !== null);
  return [...sessions.values()];
}

let deletionRunning = false;

export async function deleteSessions(
  sessions: Session[],
  onProgress?: (completed: number) => void,
): Promise<DeletionReport> {
  if (deletionRunning) throw new Error('A deletion operation is already running. Wait for it to finish.');
  deletionRunning = true;
  const unique = [...new Map(sessions.map(session => [session.sessionId, session])).values()];
  const succeeded = new Set<string>();
  const failed = new Map<string, string>();
  let next = 0;
  let stopped = false;
  let retryAt: number | null = null;
  async function worker() {
    while (!stopped && next < unique.length) {
      const session = unique[next++]!;
      try {
        const response = await fetch(`${basePath}/${encodeURIComponent(session.sessionId)}`, {
          method: 'DELETE', credentials: 'omit', cache: 'no-store',
        });
        // Stop the queue before reading an error body so other workers cannot start more requests.
        if ([401, 403, 429].includes(response.status)) stopped = true;
        const responseRetryAt = retryTime(response);
        if (responseRetryAt !== null) retryAt = Math.max(retryAt ?? 0, responseRetryAt);
        if (response.status !== 204) throw await responseError(response, responseRetryAt);
        succeeded.add(session.sessionId);
      } catch (error) {
        failed.set(session.sessionId, error instanceof ApiError ? error.message :
          'The deletion result is unknown because the connection failed. Refresh to confirm before trying this session again.');
      }
      onProgress?.(succeeded.size + failed.size);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(3, unique.length) }, worker));
    return {
      succeeded: unique.filter(session => succeeded.has(session.sessionId)),
      failed: unique.filter(session => failed.has(session.sessionId)).map(session => ({
        session, error: failed.get(session.sessionId)!,
      })),
      skipped: unique.slice(next),
      retryAt,
    };
  } finally {
    deletionRunning = false;
  }
}
