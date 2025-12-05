# Gmail Workspace Design

## Goal

Create a workspace that connects to Gmail via OAuth2, syncs emails to a local database, and supports deletion. This enables querying and archiving emails locally with SQLite and Markdown indexes.

## Prerequisites (User Setup Required)

1. **Google Cloud Platform account**
   - Create a GCP project
   - Enable the Gmail API
   - Configure OAuth consent screen (can be "Testing" mode for personal use)

2. **OAuth 2.0 credentials**
   - Create Desktop App credentials (or Web App with localhost redirect)
   - Download client ID and secret
   - Set environment variables:
     ```bash
     export GMAIL_CLIENT_ID="your-client-id"
     export GMAIL_CLIENT_SECRET="your-client-secret"
     ```

## Authentication Design

### OAuth2 Flow (CLI-friendly)

The login flow works without requiring a full web server setup:

1. User calls `login` action
2. Workspace starts a temporary HTTP server on `localhost:3000` (or configurable port)
3. Opens browser to Google's OAuth consent page
4. User grants permissions in browser
5. Google redirects to `http://localhost:3000/callback?code=...`
6. Workspace exchanges auth code for tokens
7. Stores `refresh_token` persistently
8. Closes temporary server

### Token Persistence

Store tokens in `.epicenter/gmail-token.json`:

```json
{
  "access_token": "ya29...",
  "refresh_token": "1//...",
  "expiry_date": 1700000000000
}
```

Use `Bun.file` and `Bun.write` following the existing persistence patterns.

### Token Refresh

The `googleapis` library automatically refreshes access tokens when they expire, as long as we set the `refresh_token` on the OAuth2 client.

### Scopes

```typescript
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',  // Read emails
  'https://www.googleapis.com/auth/gmail.modify',    // Delete/trash emails
];
```

## Schema Design

```typescript
const EMAILS_SCHEMA = {
  id: id(),                          // Our stable ID
  gmailId: text(),                   // Gmail's message ID
  threadId: text(),                  // Gmail thread ID
  subject: text(),
  from: text(),                      // Sender email/name
  to: text(),                        // Recipients (comma-separated)
  snippet: text(),                   // Preview text from Gmail
  body: text(),                      // Full email body (plain text or HTML)
  date: date(),                      // When email was sent
  receivedAt: date(),                // When we synced it
  labels: text({ nullable: true }),  // Gmail labels (comma-separated)
  isRead: boolean({ default: false }),
  isStarred: boolean({ default: false }),
};
```

## Exported Actions

### Authentication

```typescript
login: defineMutation({
  description: 'Authenticate with Gmail via OAuth2',
  handler: async () => {
    // 1. Check if already authenticated
    // 2. Start local callback server
    // 3. Generate auth URL and open browser
    // 4. Wait for callback with auth code
    // 5. Exchange code for tokens
    // 6. Store tokens to file
    // 7. Close server
  },
});

logout: defineMutation({
  description: 'Remove stored Gmail credentials',
  handler: async () => {
    // Delete .epicenter/gmail-token.json
  },
});

isAuthenticated: defineQuery({
  description: 'Check if Gmail credentials exist',
  handler: () => {
    // Check if token file exists and has refresh_token
  },
});
```

### Email Sync

```typescript
sync: defineMutation({
  description: 'Sync all emails from Gmail to local database',
  handler: async () => {
    // 1. Load credentials
    // 2. Initialize Gmail API client
    // 3. List all message IDs (paginated)
    // 4. For each message, fetch full details
    // 5. Insert/update in local database
  },
});

// Alternative: incremental sync using Gmail history API
syncIncremental: defineMutation({
  description: 'Sync only new/changed emails since last sync',
  handler: async () => {
    // Use Gmail History API to get changes since last historyId
  },
});
```

### Email Operations

```typescript
deleteEmail: defineMutation({
  input: type({ emailId: 'string' }),
  description: 'Permanently delete email from Gmail and local database',
  handler: async ({ emailId }) => {
    // 1. Look up gmailId from local database
    // 2. Call gmail.users.messages.delete
    // 3. Delete from local database
  },
});

trashEmail: defineMutation({
  input: type({ emailId: 'string' }),
  description: 'Move email to trash',
  handler: async ({ emailId }) => {
    // 1. Look up gmailId from local database
    // 2. Call gmail.users.messages.trash
    // 3. Update labels in local database
  },
});
```

## Indexes

### SQLite Index

Standard SQLite index for fast querying:

```typescript
indexes: {
  sqlite: (c) => sqliteIndex(c),
}
```

### Markdown Index

Each email becomes a markdown file:

```markdown
---
subject: "Meeting tomorrow"
from: "alice@example.com"
to: "bob@example.com"
date: "2024-01-15T10:30:00.000Z"
labels: "INBOX,IMPORTANT"
isRead: true
isStarred: false
---

Hey Bob,

Just confirming our meeting tomorrow at 2pm.

Best,
Alice
```

## Dependencies

Add to package.json:

```json
{
  "dependencies": {
    "googleapis": "^140.0.0",
    "open": "^10.0.0"
  }
}
```

## File Structure

```
examples/content-hub/
├── email/
│   ├── email.workspace.ts      # Existing (static storage)
│   └── gmail.workspace.ts      # New (Gmail API integration)
└── .epicenter/
    ├── gmail.yjs               # YJS document persistence
    └── gmail-token.json        # OAuth tokens (gitignored)
```

## Security Considerations

1. **Token storage**: `.epicenter/gmail-token.json` should be in `.gitignore`
2. **Credential exposure**: CLIENT_ID and CLIENT_SECRET via env vars, not hardcoded
3. **Scope minimization**: Only request `readonly` and `modify`, not full `mail.google.com`
4. **Token cleanup**: `logout` action should delete tokens when no longer needed

## Todo Checklist

- [ ] Create gmail.workspace.ts with schema
- [ ] Add googleapis and open dependencies
- [ ] Implement token storage/loading utilities
- [ ] Implement login action with OAuth flow
- [ ] Implement logout action
- [ ] Implement isAuthenticated query
- [ ] Implement sync action (full sync)
- [ ] Implement deleteEmail action
- [ ] Implement trashEmail action
- [ ] Add SQLite index
- [ ] Add Markdown index with email serialization
- [ ] Test full flow end-to-end
- [ ] Update .gitignore for token file

## Open Questions

1. **Port for OAuth callback**: Fixed port (3000) or dynamic port finding?
2. **Full sync vs incremental**: Start with full sync, add incremental later?
3. **Email body format**: Store HTML, plain text, or both?
4. **Batch fetching**: How many emails to fetch per request? (Gmail API has rate limits)
5. **Error handling**: What happens if token expires mid-sync?

## Review

[To be filled after implementation]
