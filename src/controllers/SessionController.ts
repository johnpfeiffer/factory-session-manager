import { ApiError, deleteSessions, fetchAllSessions, fetchChildSessions, fetchSessionMessages, filterSessions } from '../models/sessions.ts';
import type { ChildSession, DeletionReport, Session, SessionFilters, SessionMessage, SessionSummary } from '../models/sessions.ts';

export interface SessionDetailsState {
  session: SessionSummary;
  children: ChildSession[] | null;
  childrenLoading: boolean;
  childrenError: string | null;
  messages: SessionMessage[] | null;
  messagesLoading: boolean;
  messagesError: string | null;
  nextCursor: string | null;
}

interface State {
  sessions: Session[];
  filters: SessionFilters;
  selected: Set<string>;
  loading: boolean;
  loaded: boolean;
  loadedCount: number;
  deleting: boolean;
  error: string | null;
  confirmation: Session[] | null;
  report: DeletionReport | null;
  completed: number;
  total: number;
  cooldownUntil: number | null;
  details: SessionDetailsState | null;
}

interface SessionApi {
  fetchAllSessions: typeof fetchAllSessions;
  deleteSessions: typeof deleteSessions;
  fetchChildSessions: typeof fetchChildSessions;
  fetchSessionMessages: typeof fetchSessionMessages;
}

// Owns asynchronous operations and selection; the React view only renders and dispatches events.
export class SessionController {
  private state: State = {
    sessions: [], filters: { search: '', archive: 'archived', sort: 'newest' },
    selected: new Set(), loading: false, loaded: false, loadedCount: 0,
    deleting: false, error: null, confirmation: null, report: null,
    completed: 0, total: 0, cooldownUntil: null, details: null,
  };
  private listeners = new Set<() => void>();
  private abortController: AbortController | null = null;
  private childrenAbort: AbortController | null = null;
  private messagesAbort: AbortController | null = null;
  private messageCursors = new Set<string>();
  private api: SessionApi;
  private now: () => number;

  constructor(api: Partial<SessionApi> = {}, now: () => number = Date.now) {
    this.api = { fetchAllSessions, deleteSessions, fetchChildSessions, fetchSessionMessages, ...api };
    this.now = now;
  }

  getSnapshot = (): State => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  get busy(): boolean { return this.state.loading || this.state.deleting; }
  get coolingDown(): boolean { return (this.state.cooldownUntil ?? 0) > this.now(); }
  get visibleSessions(): Session[] { return filterSessions(this.state.sessions, this.state.filters); }

  async load(): Promise<void> {
    if (this.busy || this.coolingDown || this.state.confirmation) return;
    const abortController = new AbortController();
    this.abortController = abortController;
    this.update({ loading: true, error: null, loadedCount: 0 });
    try {
      const sessions = await this.api.fetchAllSessions(abortController.signal,
        loadedCount => { if (!abortController.signal.aborted) this.update({ loadedCount }); });
      if (abortController.signal.aborted) return;
      const available = new Set(sessions.map(session => session.sessionId));
      this.update({ sessions, loaded: true, loadedCount: sessions.length,
        selected: new Set([...this.state.selected].filter(id => available.has(id))) });
    } catch (error) {
      if (abortController.signal.aborted) return;
      this.update({ error: error instanceof Error ? error.message : 'Unable to load sessions.',
        ...(error instanceof ApiError && error.retryAt !== null ? { cooldownUntil: error.retryAt } : {}) });
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
        this.update({ loading: false });
      }
    }
  }

  cancelLoad = () => { this.abortController?.abort(); this.closeDetails(); };

  private patchDetails(patch: Partial<SessionDetailsState>) {
    if (this.state.details) this.update({ details: { ...this.state.details, ...patch } });
  }
  private detailError(field: 'childrenError' | 'messagesError', error: unknown) {
    this.patchDetails({ [field]: error instanceof Error ? error.message : 'Unable to load session information.' });
    if (error instanceof ApiError && error.retryAt !== null) {
      this.update({ cooldownUntil: Math.max(this.state.cooldownUntil ?? 0, error.retryAt) });
    }
  }
  closeDetails = () => {
    this.childrenAbort?.abort();
    this.messagesAbort?.abort();
    this.childrenAbort = null;
    this.messagesAbort = null;
    this.messageCursors.clear();
    if (this.state.details) this.update({ details: null });
  };
  async openDetails(session: SessionSummary): Promise<void> {
    if (this.busy || this.state.confirmation || this.state.details?.session.sessionId === session.sessionId) return;
    this.closeDetails();
    this.update({ details: { session, children: null, childrenLoading: false, childrenError: null,
      messages: null, messagesLoading: false, messagesError: null, nextCursor: null } });
    await this.loadChildren();
  }
  async loadChildren(): Promise<void> {
    const details = this.state.details;
    if (!details || this.busy || this.coolingDown || details.childrenLoading) return;
    const operation = new AbortController();
    this.childrenAbort = operation;
    this.patchDetails({ childrenLoading: true, childrenError: null });
    try {
      const children = await this.api.fetchChildSessions(details.session.sessionId, operation.signal);
      if (!operation.signal.aborted) this.patchDetails({ children });
    } catch (error) {
      if (!operation.signal.aborted) this.detailError('childrenError', error);
    } finally {
      if (this.childrenAbort === operation) {
        this.childrenAbort = null;
        this.patchDetails({ childrenLoading: false });
      }
    }
  }
  async loadMessages(more = false): Promise<void> {
    const details = this.state.details;
    if (!details || this.busy || this.coolingDown || details.messagesLoading || (more && !details.nextCursor)) return;
    const cursor = more ? details.nextCursor : null;
    const operation = new AbortController();
    this.messagesAbort = operation;
    this.patchDetails({ messagesLoading: true, messagesError: null });
    try {
      const page = await this.api.fetchSessionMessages(details.session.sessionId, cursor, operation.signal);
      if (operation.signal.aborted) return;
      if (page.nextCursor && (page.nextCursor === cursor || (more && this.messageCursors.has(page.nextCursor)))) {
        throw new Error('Factory returned a repeated message cursor. Refresh messages to start again.');
      }
      if (!more) this.messageCursors.clear();
      if (cursor) this.messageCursors.add(cursor);
      const messages = new Map((more ? details.messages ?? [] : []).map(message => [message.id, message]));
      page.messages.forEach(message => messages.set(message.id, message));
      this.patchDetails({ messages: [...messages.values()], nextCursor: page.nextCursor });
    } catch (error) {
      if (!operation.signal.aborted) this.detailError('messagesError', error);
    } finally {
      if (this.messagesAbort === operation) {
        this.messagesAbort = null;
        this.patchDetails({ messagesLoading: false });
      }
    }
  }
  setFilters(filters: Partial<SessionFilters>) { this.update({ filters: { ...this.state.filters, ...filters } }); }
  toggleSelected(id: string) {
    if (this.busy || this.state.confirmation || !this.state.sessions.some(session => session.sessionId === id)) return;
    const selected = new Set(this.state.selected);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    this.update({ selected });
  }
  selectFiltered() {
    if (this.busy || this.state.confirmation) return;
    this.update({ selected: new Set([...this.state.selected, ...this.visibleSessions.map(session => session.sessionId)]) });
  }
  deselectFiltered() {
    if (this.busy || this.state.confirmation) return;
    const visible = new Set(this.visibleSessions.map(session => session.sessionId));
    this.update({ selected: new Set([...this.state.selected].filter(id => !visible.has(id))) });
  }
  clearSelection() { if (!this.busy && !this.state.confirmation) this.update({ selected: new Set() }); }
  requestDelete(ids: string[]) {
    if (this.busy || this.coolingDown || this.state.confirmation) return;
    const requested = new Set(ids);
    const confirmation = this.state.sessions.filter(session => requested.has(session.sessionId));
    if (confirmation.length) this.update({ confirmation });
  }
  requestDeleteSelected() { this.requestDelete([...this.state.selected]); }
  closeConfirmation() { if (!this.state.deleting) this.update({ confirmation: null }); }
  async confirmDeletion(): Promise<void> {
    if (this.busy || this.coolingDown || !this.state.confirmation?.length) return;
    const sessions = this.state.confirmation;
    this.update({ deleting: true, confirmation: null, report: null, error: null, completed: 0, total: sessions.length });
    try {
      const report = await this.api.deleteSessions(sessions, completed => this.update({ completed }));
      const deleted = new Set(report.succeeded.map(session => session.sessionId));
      if (this.state.details && deleted.has(this.state.details.session.sessionId)) this.closeDetails();
      this.update({ report, sessions: this.state.sessions.filter(session => !deleted.has(session.sessionId)),
        selected: new Set([...this.state.selected].filter(id => !deleted.has(id))),
        cooldownUntil: Math.max(this.state.cooldownUntil ?? 0, report.retryAt ?? 0) || null });
    } catch (error) {
      this.update({ error: error instanceof Error ? error.message : 'Deletion could not be confirmed. Refresh before trying again.' });
    } finally {
      this.update({ deleting: false });
    }
  }
}
