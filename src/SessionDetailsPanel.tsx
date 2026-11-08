import { Alert, Box, Button, Divider, Drawer, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import type { SessionController, SessionDetailsState } from './controllers/SessionController.ts';
import { sessionTitle } from './models/sessions.ts';
import type { MessageContent } from './models/sessions.ts';

function MessageBlock({ block }: { block: MessageContent }) {
  if (block.type === 'text' && typeof block.text === 'string') {
    return <Typography className="message-text">{block.text}</Typography>;
  }
  if (block.type === 'tool_use') {
    return <details className="message-tool">
      <summary>Tool call: {typeof block.name === 'string' ? block.name : 'Unnamed tool'}</summary>
      <pre className="message-text">{JSON.stringify(block.input, null, 2)}</pre>
    </details>;
  }
  if (block.type === 'tool_result') {
    return <details className="message-tool">
      <summary>Tool result{block.isError === true ? ' (error)' : ''}</summary>
      {typeof block.content === 'string' ? <Typography className="message-text">{block.content}</Typography>
        : Array.isArray(block.content) ? block.content.map((item, index) =>
          item && typeof item === 'object' && typeof item.type === 'string'
            ? <MessageBlock key={index} block={item as MessageContent} /> : null)
          : <Typography variant="body2">No text content.</Typography>}
    </details>;
  }
  if (block.type === 'document') {
    const source = block.source;
    if (source && typeof source === 'object' && 'type' in source && source.type === 'text' && 'data' in source && typeof source.data === 'string') {
      return <Typography className="message-text">{source.data}</Typography>;
    }
  }
  const label = block.type === 'image' ? 'Image attachment' : block.type === 'document' ? 'Document attachment'
    : block.type === 'thinking' || block.type === 'redacted_thinking' ? 'Reasoning block' : `${block.type} content`;
  return <Typography variant="body2" color="text.secondary">[{label}]</Typography>;
}

export default function SessionDetailsPanel({ details, controller, remainingSeconds }: {
  details: SessionDetailsState | null;
  controller: SessionController;
  remainingSeconds: number;
}) {
  const readDisabled = controller.busy || remainingSeconds > 0;
  return <Drawer anchor="right" open={Boolean(details)} onClose={controller.closeDetails}
    slotProps={{ paper: { role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'session-details-title',
      sx: { width: { xs: '100%', sm: 680 }, maxWidth: '100%' } } }}>
    {details && <Box sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" color="text.secondary">Session details</Typography>
          <Typography id="session-details-title" component="h2" variant="h5" sx={{ overflowWrap: 'anywhere' }}>
            {sessionTitle(details.session)}
          </Typography>
        </Box>
        <Button onClick={controller.closeDetails}>Close</Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" className="session-id">{details.session.sessionId}</Typography>
      <Typography sx={{ mt: 1 }}>Status: {details.session.status}</Typography>
      {remainingSeconds > 0 && <Alert severity="warning" sx={{ mt: 2 }}>
        Rate limit reached. Wait {remainingSeconds} second{remainingSeconds === 1 ? '' : 's'} before loading more data.
      </Alert>}
      <Divider sx={{ my: 3 }} />

      <Box component="section" aria-labelledby="children-heading" sx={{ mb: 3 }}>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography id="children-heading" component="h3" variant="h6">Child sessions{details.children ? ` (${details.children.length})` : ''}</Typography>
          <Button disabled={readDisabled || details.childrenLoading} onClick={() => void controller.loadChildren()}>
            {details.children === null ? details.childrenError ? 'Retry children' : 'Get children' : 'Refresh children'}
          </Button>
        </Stack>
        {details.childrenError && <Alert severity="error" sx={{ mb: 2 }}>{details.childrenError}</Alert>}
        {details.childrenLoading && <Box role="status" sx={{ mb: 2 }}>
          <Typography variant="body2" sx={{ mb: 1 }}>Loading child sessions…</Typography><LinearProgress />
        </Box>}
        {details.children?.length === 0 && <Typography color="text.secondary">No child sessions.</Typography>}
        {!details.children && !details.childrenLoading && !details.childrenError && <Typography color="text.secondary">Child sessions have not been loaded.</Typography>}
        {details.children && <Box component="ul" className="child-list">
          {details.children.map(child => <Paper component="li" key={child.sessionId} variant="outlined" sx={{ p: 2 }}>
            <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{sessionTitle(child)}</Typography>
            <Typography variant="body2" color="text.secondary" className="session-id">{child.sessionId}</Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>Status: {child.status}</Typography>
            <Typography variant="body2" color="text.secondary">Created: {new Date(child.createdAt).toLocaleString()}</Typography>
            <Typography variant="body2" color="text.secondary">Updated: {new Date(child.updatedAt).toLocaleString()}</Typography>
          </Paper>)}
        </Box>}
      </Box>

      <Divider sx={{ my: 3 }} />
      <Box component="section" aria-labelledby="messages-heading">
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography id="messages-heading" component="h3" variant="h6">Messages</Typography>
          <Button variant="outlined" disabled={readDisabled || details.messagesLoading} onClick={() => void controller.loadMessages()}>
            {details.messages === null ? 'Get messages' : 'Refresh messages'}
          </Button>
        </Stack>
        {details.messages === null && !details.messagesLoading && !details.messagesError && <Typography color="text.secondary">Load this session's message history when you need it.</Typography>}
        {details.messagesError && <Alert severity="error" sx={{ mb: 2 }}>{details.messagesError}</Alert>}
        {details.messages && <Typography variant="body2" color="text.secondary" aria-live="polite" sx={{ mb: 2 }}>
          {details.messages.length} message{details.messages.length === 1 ? '' : 's'} loaded{details.nextCursor ? ' · More available' : ''}
        </Typography>}
        {details.messages?.length === 0 && <Typography color="text.secondary">No messages in this session.</Typography>}
        <Box component="ol" className="message-list">
          {details.messages?.map(message => <Paper component="li" key={message.id} variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', flexWrap: 'wrap', mb: 1 }}>
              <Typography sx={{ fontWeight: 500 }}>{message.role}</Typography>
              <Typography variant="body2" color="text.secondary">{new Date(message.createdAt).toLocaleString()}</Typography>
            </Stack>
            {message.content.length ? message.content.map((block, index) => <MessageBlock key={index} block={block} />)
              : <Typography variant="body2" color="text.secondary">No message content.</Typography>}
          </Paper>)}
        </Box>
        {details.messagesLoading && <Box role="status" sx={{ my: 2 }}>
          <Typography variant="body2" sx={{ mb: 1 }}>Loading messages…</Typography><LinearProgress />
        </Box>}
        {details.nextCursor && <Button disabled={readDisabled || details.messagesLoading} onClick={() => void controller.loadMessages(true)} sx={{ mt: 2 }}>
          Load more messages
        </Button>}
      </Box>
    </Box>}
  </Drawer>;
}
