# Multi-Server Architecture for Opencode SH

## Overview

This spec outlines the design for adding a multi-server connection layer to the Opencode SH application. This allows users to connect to multiple Opencode instances running on different ports/URLs with authentication.

## Terminology

After considering various options, I recommend using **"workspaces"** instead of "instances" as it:
- Implies a separate working environment
- Is familiar to developers (VS Code workspaces, Slack workspaces)
- Less technical than "instances" or "endpoints"
- More descriptive than generic terms like "connections"

Alternative options considered:
- Servers (technical but accurate)
- Connections (generic)
- Environments (could be confused with dev/prod)
- Hosts (too low-level)

## Architecture

### Data Model

```typescript
type Workspace = {
  id: string;          // UUID
  name: string;        // User-friendly name
  url: string;         // ngrok URL (always)
  port: number;        // Port number for opencode serve
  username: string;    // Basic auth username
  password: string;    // Basic auth password (stored encrypted)
  createdAt: number;   // Unix timestamp
  lastUsedAt: number;  // Unix timestamp
}
```

### Storage Strategy

For maximum portability between web and desktop environments, we'll use **localStorage** to store an array of workspaces:

```typescript
// Storage key
const WORKSPACES_KEY = 'opencode-workspaces';

// Simple array storage - no active workspace concept
type StoredWorkspaces = Workspace[];
```

### Reactive State Architecture

Instead of using a service pattern, we'll leverage `createPersistedState` for a simpler, more Svelte-native approach:

```typescript
// workspaces.svelte.ts - Reactive workspace management
import { createPersistedState } from '@epicenter/svelte-utils';
import { z } from 'zod';
import { nanoid } from 'nanoid';

// Define the workspace schema
const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().url(),
  port: z.number(),
  username: z.string(),
  password: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
});

const workspacesSchema = z.array(workspaceSchema);

// Create the persisted state
export const workspaces = createPersistedState({
  key: 'opencode-workspaces',
  schema: workspacesSchema,
  onParseError: (error) => {
    // Handle different error types gracefully
    if (error.type === 'storage_empty') {
      return []; // First time user
    }
    
    if (error.type === 'json_parse_error') {
      console.error('Corrupted workspace data:', error);
      // Could show a recovery UI here
      return [];
    }
    
    if (error.type === 'schema_validation_failed') {
      console.warn('Invalid workspace data, attempting recovery');
      // Try to recover partial data
      if (Array.isArray(error.value)) {
        return error.value.filter(w => {
          try {
            workspaceSchema.parse(w);
            return true;
          } catch {
            return false;
          }
        });
      }
    }
    
    return []; // Fallback to empty array
  },
  onUpdateError: (error) => {
    console.error('Failed to save workspaces:', error);
    toast.error('Failed to save changes');
  }
});

// Helper functions for workspace operations
export function createWorkspace(data: Omit<Workspace, 'id' | 'createdAt' | 'lastUsedAt'>) {
  const newWorkspace: Workspace = {
    ...data,
    id: nanoid(),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  
  workspaces.value = [...workspaces.value, newWorkspace];
  return newWorkspace;
}

export function updateWorkspace(id: string, updates: Partial<Workspace>) {
  workspaces.value = workspaces.value.map(w => 
    w.id === id ? { ...w, ...updates, lastUsedAt: Date.now() } : w
  );
}

export function deleteWorkspace(id: string) {
  workspaces.value = workspaces.value.filter(w => w.id !== id);
}

export function getWorkspace(id: string) {
  return workspaces.value.find(w => w.id === id);
}
```

This approach provides:
- **Synchronous access**: No async/await needed
- **Reactive updates**: UI automatically updates when workspaces change
- **Cross-tab sync**: Changes in one tab reflect in others
- **Type safety**: Full TypeScript support with Zod validation
- **Simplicity**: Direct manipulation of state without Result types

### API Client Integration

The API client needs to be enhanced to support dynamic base URLs and authentication. This will require making all client calls lazy throughout the entire codebase:

```typescript
// Modified client factory
function createClient(workspace: Workspace) {
  return createAPIClient({
    baseUrl: workspace.url,
    headers: {
      'Authorization': `Basic ${btoa(`${workspace.username}:${workspace.password}`)}`
    }
  });
}

// All API calls need to be updated from:
const data = await api.getSession();

// To lazy evaluation:
const client = createClient(activeWorkspace);
const data = await client.getSession();
```

## User Flow

### Adding a New Workspace

1. User clicks "Add Workspace" button
2. Modal shows configuration form:
   - **Step 1**: Enter credentials
     - Username (text input)
     - Password (text input)
   - **Step 2**: Select port
     - Port number (pre-filled with random port like 52341)
     - User can edit if desired
3. Modal shows setup instructions with pre-populated values:
   
   **Step 3**: Run this command in your project directory
   ```bash
   opencode serve -p 52341
   ```
   
   **Step 4**: In another terminal, expose it with ngrok
   ```bash
   ngrok http 52341 --basic-auth="myuser:mypass"
   ```
   
   **Step 5**: Copy the ngrok URL and paste below
   - ngrok URL input field (e.g., https://abc123.ngrok.io)
   
   ---
   
   **Quick Setup** (Advanced)
   
   Run both commands in one line:
   ```bash
   opencode serve -p 52341 & ngrok http 52341 --basic-auth="myuser:mypass"
   ```
   
4. User enters workspace name (e.g., "My Project")
5. System tests the connection
6. If successful, workspace is saved and set as active

### Port Generation

Generate random ports in the safe user range (49152-65535):

```typescript
function generateRandomPort(): number {
  return Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152;
}
```

### Managing Workspaces

- Table view showing all workspaces with columns:
  - Name
  - URL
  - Port
  - Last Used
  - Status (Connected/Disconnected - based on real-time connection test)
  - Actions (Connect to Session, Edit, Delete)
- Connection status is determined dynamically, not persisted
- Each workspace can be used independently
- No concept of "active" workspace - users choose which workspace when creating sessions

## Implementation Plan

### Phase 1: Core Infrastructure
- [ ] Create workspace types in `/apps/sh/src/lib/types/workspace.ts`
- [ ] Create reactive workspace store in `/apps/sh/src/lib/stores/workspaces.svelte.ts`
- [ ] Implement using createPersistedState with Zod schema
- [ ] Add helper functions for CRUD operations

### Phase 2: Connection Management
- [ ] Create connection health check functions
- [ ] Add workspace validation before saving
- [ ] Implement password encryption helper
- [ ] Add workspace URL testing capability

### Phase 3: API Integration
- [ ] Modify API client to accept dynamic configuration per workspace
- [ ] Create client factory that accepts workspace parameter
- [ ] Update all query functions to accept workspace context
- [ ] Make all API calls lazy with workspace injection

### Phase 4: UI Components
- [ ] Create WorkspaceList component (table view)
- [ ] Create AddWorkspaceModal with setup instructions
- [ ] Add workspace selector when creating sessions
- [ ] Create connection status indicator per workspace

### Phase 5: Session Integration
- [ ] Update session queries to accept workspace parameter
- [ ] Pass workspace through to all API calls
- [ ] Show which workspace a session belongs to
- [ ] Allow selecting workspace when creating new sessions

## Security Considerations

1. **Password Storage**: Use a simple encryption for localStorage (not bulletproof but better than plaintext)
2. **Connection Security**: Always use HTTPS/ngrok for remote connections
3. **Auth Headers**: Ensure auth headers are only sent to trusted domains
4. **Workspace Isolation**: Sessions and data should be isolated per workspace

## Questions to Resolve

1. Should workspaces be persisted across browser sessions? (Yes, using localStorage)
2. Should we support importing/exporting workspace configurations?
3. Should we add connection health checks/auto-reconnect?
4. Do we need workspace-specific settings (e.g., default model per workspace)?

## Next Steps

1. Get feedback on the "workspaces" terminology
2. Confirm localStorage is acceptable for credential storage
3. Begin implementation with Phase 1 (core infrastructure)