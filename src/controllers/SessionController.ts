import { ApiError, deleteSessions, fetchAllSessions, filterSessions } from '../models/sessions.ts';
import type { DeletionReport, Session, SessionFilters } from '../models/sessions.ts';

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
}

interface SessionApi {
  fetchAllSessions: typeof fetchAllSessions;
  deleteSessions: typeof deleteSessions;
}

// Owns asynchronous operations and selection; the React view only renders and dispatches events.
export class SessionController {
  private state: State = {
    sessions: [], filters: { search: '', archive: 'archived', sort: 'newest' },
    selected: new Set(), loading: false, loaded: false, loadedCount: 0,
    deleting: false, error: null, confirmation: null, report: null,
    completed: 0, total: 0, cooldownUntil: null,
  };
  private listeners = new Set<() => void>();
  private abortController: AbortController | null = null;
  private api: SessionApi;
  private now: () => number;

  constructor(api: SessionApi = { fetchAllSessions, deleteSessions }, now: () => number = Date.now) {
    this.api = api;
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

  cancelLoad = () => { this.abortController?.abort(); };
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
