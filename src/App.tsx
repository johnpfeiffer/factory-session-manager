import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Checkbox,
  Container, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle,
  Divider, FormControl, InputLabel, LinearProgress, MenuItem, Paper, Select,
  Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { SessionController } from './controllers/SessionController.ts';
import { isArchived, sessionTitle } from './models/sessions.ts';
import type { DeletionReport, Session } from './models/sessions.ts';
import SessionDetailsPanel from './SessionDetailsPanel.tsx';

const defaultController = new SessionController();
const countLabel = (count: number) => `${count} session${count === 1 ? '' : 's'}`;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function SessionDate({ timestamp }: { timestamp: number }) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return <span>Unavailable</span>;
  return <span title={date.toLocaleString()}>
    <span className="date-part">{dateFormat.format(date)}</span>
    <Typography component="span" variant="body2" color="text.secondary" className="time-part">
      {timeFormat.format(date)}
    </Typography>
  </span>;
}

function ResultList({ sessions }: { sessions: Session[] }) {
  return <ul className="result-list">{sessions.map(session => <li key={session.sessionId}>
    {sessionTitle(session)} <Typography component="span" variant="body2" color="text.secondary">
      ({session.sessionId})
    </Typography>
  </li>)}</ul>;
}

function DeletionResults({ report }: { report: DeletionReport }) {
  return <Box aria-live="polite" sx={{ mb: 3 }}>
    <Accordion defaultExpanded={report.failed.length > 0 || report.skipped.length > 0} variant="outlined" disableGutters>
      <AccordionSummary expandIcon={<span aria-hidden="true">⌄</span>} aria-controls="deletion-results" id="deletion-results-heading">
        <Typography>Deletion results: {report.succeeded.length} succeeded, {report.failed.length} failed,
          {' '}{report.skipped.length} not attempted</Typography>
      </AccordionSummary>
      <AccordionDetails id="deletion-results" className="results-detail">
        <Stack spacing={2}>
          {report.succeeded.length > 0 && <Box>
            <Alert severity="success">Deleted {countLabel(report.succeeded.length)}.</Alert>
            <ResultList sessions={report.succeeded} />
          </Box>}
          {report.failed.length > 0 && <Box>
            <Alert severity="error">{countLabel(report.failed.length)} could not be confirmed deleted. Review each error before trying again.</Alert>
            <ul className="result-list">{report.failed.map(({ session, error }) => <li key={session.sessionId}>
              <Typography>{sessionTitle(session)}</Typography>
              <Typography variant="body2" color="text.secondary">{session.sessionId}</Typography>
              <Typography variant="body2" color="error">{error}</Typography>
            </li>)}</ul>
          </Box>}
          {report.skipped.length > 0 && <Box>
            <Alert severity="warning">{countLabel(report.skipped.length)} not attempted because the queue stopped. No requests will be retried automatically.</Alert>
            <ResultList sessions={report.skipped} />
          </Box>}
        </Stack>
      </AccordionDetails>
    </Accordion>
  </Box>;
}

export default function App({ controller = defaultController }: { controller?: SessionController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { void controller.load(); return controller.cancelLoad; }, [controller]);
  useEffect(() => {
    setNow(Date.now());
    const deadline = state.cooldownUntil;
    if (!deadline || deadline <= Date.now()) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= deadline) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [state.cooldownUntil]);
  const remainingSeconds = Math.max(0, Math.ceil(((state.cooldownUntil ?? 0) - now) / 1000));
  const busy = state.loading || state.deleting;
  const deletionDisabled = busy || remainingSeconds > 0;
  const visible = controller.visibleSessions;
  const visibleSelected = visible.filter(session => state.selected.has(session.sessionId)).length;
  const allVisibleSelected = visible.length > 0 && visibleSelected === visible.length;
  const hiddenSelected = state.selected.size - visibleSelected;

  return <Container component="main" maxWidth="xl" sx={{ py: { xs: 3, md: 5 } }}>
    <Stack direction="row" spacing={2} sx={{ mb: 1, justifyContent: 'space-between', alignItems: 'center' }}>
      <Typography component="h1" variant="h4">Factory session manager</Typography>
      <Button variant="outlined" disabled={busy || remainingSeconds > 0} onClick={() => void controller.load()}>Refresh</Button>
    </Stack>
    <Typography color="text.secondary" sx={{ mb: 3 }}>Review and delete your Factory sessions. Runs locally on this computer.</Typography>
    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
      Double-click a session row or choose its title to see child sessions and messages.
    </Typography>

    {state.error && <Alert severity="error" sx={{ mb: 2 }}>{state.error}</Alert>}
    {remainingSeconds > 0 && <Alert severity="warning" sx={{ mb: 2 }}>
      Rate limit reached. Wait {remainingSeconds} second{remainingSeconds === 1 ? '' : 's'} before refreshing or deleting again.
      {' '}No requests will be retried automatically.
    </Alert>}
    {state.report && <DeletionResults key={state.total + ':' + state.report.succeeded.map(s => s.sessionId).join(',') + ':' + state.report.failed.map(f => f.session.sessionId).join(',')} report={state.report} />}

    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
      <Stack className="filters" direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField label="Search title or session ID" value={state.filters.search} disabled={busy}
          onChange={event => controller.setFilters({ search: event.target.value })} size="small" sx={{ flex: 1 }} />
        <FormControl size="small" sx={{ minWidth: 160 }} disabled={busy}>
          <InputLabel id="archive-label">Archive state</InputLabel>
          <Select labelId="archive-label" label="Archive state" value={state.filters.archive}
            onChange={event => controller.setFilters({ archive: event.target.value })}>
            <MenuItem value="archived">Archived</MenuItem>
            <MenuItem value="active">Active</MenuItem>
            <MenuItem value="all">All sessions</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 195 }} disabled={busy}>
          <InputLabel id="sort-label">Last updated</InputLabel>
          <Select labelId="sort-label" label="Last updated" value={state.filters.sort}
            onChange={event => controller.setFilters({ sort: event.target.value })}>
            <MenuItem value="newest">Newest first</MenuItem>
            <MenuItem value="oldest">Oldest first</MenuItem>
          </Select>
        </FormControl>
      </Stack>
    </Paper>

    <Stack className="selection-toolbar" direction={{ xs: 'column', sm: 'row' }} spacing={1}
      sx={{ mb: 2, alignItems: { sm: 'center' }, justifyContent: 'space-between' }}>
      <Box aria-live="polite">
        <Typography>{countLabel(state.sessions.length)} loaded · {visible.length} shown · {state.selected.size} selected</Typography>
        {hiddenSelected > 0 && <Typography variant="body2" color="text.secondary">{hiddenSelected} selected outside the current filter</Typography>}
      </Box>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Button disabled={busy || !visible.length || allVisibleSelected} onClick={() => controller.selectFiltered()}>Select all filtered</Button>
        <Button disabled={busy || !state.selected.size} onClick={() => controller.clearSelection()}>Clear selection</Button>
        <Button variant="contained" color="error" disabled={deletionDisabled || !state.selected.size}
          onClick={() => controller.requestDeleteSelected()}>Delete selected ({state.selected.size})</Button>
      </Stack>
    </Stack>

    {(state.loading || state.deleting) && <Box role="status" sx={{ mb: 2 }}>
      <Typography sx={{ mb: 1 }}>{state.loading ? `Loading sessions… ${state.loadedCount} loaded` : `Deleting sessions… ${state.completed} of ${state.total} finished`}</Typography>
      <LinearProgress {...(state.deleting ? { variant: 'determinate' as const, value: state.total ? state.completed / state.total * 100 : 0 } : {})} />
    </Box>}

    <Paper variant="outlined" className="sessions-paper" aria-busy={busy}>
      <Table className="session-table" size="small" aria-label="Factory sessions">
        <TableHead>
          <TableRow>
            <TableCell padding="checkbox" sx={{ width: 48 }}>
              <Checkbox checked={allVisibleSelected} indeterminate={visibleSelected > 0 && !allVisibleSelected}
                disabled={busy || !visible.length} slotProps={{ input: { 'aria-label': 'Select all filtered sessions' } }}
                onChange={() => allVisibleSelected ? controller.deselectFiltered() : controller.selectFiltered()} />
            </TableCell>
            <TableCell sx={{ width: '32%' }}>Session</TableCell>
            <TableCell>Status</TableCell>
            <TableCell sx={{ width: 112 }}>Messages</TableCell>
            <TableCell>Created</TableCell>
            <TableCell>Updated</TableCell>
            <TableCell sx={{ width: 112 }}><span className="visually-hidden">Actions</span></TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {visible.map(session => <TableRow key={session.sessionId} selected={state.selected.has(session.sessionId)}
            onDoubleClick={event => {
              if (event.target instanceof Element && !event.target.closest('button, input, label, a')) void controller.openDetails(session);
            }}>
            <TableCell className="selection-cell" padding="checkbox">
              <Checkbox checked={state.selected.has(session.sessionId)} disabled={busy}
                slotProps={{ input: { 'aria-label': `Select ${sessionTitle(session)} (${session.sessionId})` } }}
                onChange={() => controller.toggleSelected(session.sessionId)} />
            </TableCell>
            <TableCell className="session-cell" component="th" scope="row">
              <Button className="session-title" disabled={busy} aria-label={`Open details for ${sessionTitle(session)} (${session.sessionId})`}
                sx={{ p: 0, minWidth: 0, textTransform: 'none', textAlign: 'left', justifyContent: 'flex-start', fontSize: '1rem', color: 'text.primary' }}
                onClick={() => void controller.openDetails(session)}>{sessionTitle(session)}</Button>
              <Typography variant="body2" color="text.secondary" className="session-id">{session.sessionId}</Typography>
            </TableCell>
            <TableCell data-label="Status">
              <Typography variant="body2">{session.status}</Typography>
              <Typography variant="body2" color="text.secondary">{isArchived(session) ? 'Archived' : 'Active'}</Typography>
            </TableCell>
            <TableCell data-label="Messages">{session.messageCount}</TableCell>
            <TableCell data-label="Created"><SessionDate timestamp={session.createdAt} /></TableCell>
            <TableCell data-label="Updated"><SessionDate timestamp={session.updatedAt} /></TableCell>
            <TableCell className="action-cell">
              <Button color="error" disabled={deletionDisabled} aria-label={`Delete ${sessionTitle(session)} (${session.sessionId})`}
                onClick={() => controller.requestDelete([session.sessionId])}>Delete</Button>
            </TableCell>
          </TableRow>)}
          {!visible.length && <TableRow><TableCell colSpan={7} className="empty-state">
            <Typography>{state.loading ? 'Loading your sessions…' : state.error && !state.loaded
              ? 'Sessions could not be loaded. Check the error above and refresh.'
              : !state.sessions.length ? 'No sessions found.' : 'No sessions match the current filters.'}</Typography>
            {!state.loading && state.sessions.length > 0 && <Typography variant="body2" color="text.secondary">
              Change the archive state or clear your search to see other sessions.
            </Typography>}
          </TableCell></TableRow>}
        </TableBody>
      </Table>
    </Paper>

    <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
      Factory may allow deleted sessions to be restored during its retention period. A successful deletion does not mean immediate permanent erasure.
      {' '}This API is available only to selected organizations.
      {' '}<a href="https://docs.factory.com/api-reference/sessions" target="_blank" rel="noreferrer">API documentation</a>
    </Typography>

    <SessionDetailsPanel details={state.details} controller={controller} remainingSeconds={remainingSeconds} />

    <Dialog open={Boolean(state.confirmation)} onClose={() => controller.closeConfirmation()} maxWidth="sm" fullWidth
      aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-description">
      <DialogTitle id="delete-dialog-title">Delete {countLabel(state.confirmation?.length ?? 0)}?</DialogTitle>
      <DialogContent>
        <DialogContentText id="delete-dialog-description">
          These sessions will be deleted from Factory. Factory may retain them for recovery during its retention period.
          Review every session before confirming.
        </DialogContentText>
        <Divider sx={{ mt: 2 }} />
        <ul className="confirmation-list">{state.confirmation?.map(session => <li key={session.sessionId}>
          <Typography>{sessionTitle(session)}</Typography>
          <Typography variant="body2" color="text.secondary" className="session-id">{session.sessionId}</Typography>
        </li>)}</ul>
      </DialogContent>
      <DialogActions>
        <Button autoFocus onClick={() => controller.closeConfirmation()}>Cancel</Button>
        <Button color="error" variant="contained" disabled={deletionDisabled}
          onClick={() => void controller.confirmDeletion()}>Delete {countLabel(state.confirmation?.length ?? 0)}</Button>
      </DialogActions>
    </Dialog>
  </Container>;
}
