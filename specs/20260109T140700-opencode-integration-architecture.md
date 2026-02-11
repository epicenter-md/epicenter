# OpenCode Integration Architecture for Epicenter

**Date**: 2026-01-09
**Status**: WIP - EXPLORATION PHASE
**Author**: Braden + Claude

## Executive Summary

This spec explores integrating [OpenCode](https://github.com/sst/opencode) (sst/opencode) as an AI backend for Epicenter apps. OpenCode is a CLI-based AI coding agent with an HTTP server mode, plugin system, and session management—making it suitable as a headless AI backend for GUI applications.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CORE IDEA                                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Epicenter App (Tauri + Svelte)                                            │
│       │                                                                     │
│       │ HTTP/SSE                                                            │
│       ▼                                                                     │
│  OpenCode Server (sidecar or user-installed)                               │
│       │                                                                     │
│       │ Custom plugins that understand Epicenter's data model              │
│       ▼                                                                     │
│  AI can query/mutate Epicenter documents via typed tools                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Background: What is OpenCode?

OpenCode is a terminal-based AI coding agent from SST (the serverless framework team).

### Key Characteristics

| Feature                | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| **Distribution**       | Single binary, installable via curl, npm, brew, etc.             |
| **Server Mode**        | `opencode serve` exposes HTTP API + SSE for real-time updates    |
| **Plugin System**      | TypeScript plugins can register custom tools the AI can invoke   |
| **Session Management** | Persistent sessions stored as JSON files                         |
| **Multi-client**       | Multiple clients can attach to same server via `opencode attach` |

### Data Storage Locations (XDG Standard)

```
~/.config/opencode/           ← XDG_CONFIG_HOME
├── opencode.json                Config file
├── plugin/                      Custom plugins (TypeScript)
│   ├── package.json             npm dependencies
│   └── *.ts                     Plugin files
├── agent/                       Custom agents (Markdown)
├── command/                     Custom slash commands
└── tool/                        Standalone tool files

~/.local/share/opencode/      ← XDG_DATA_HOME
├── auth.json                    API keys, OAuth tokens
├── log/                         Application logs
└── project/                     Session data
    └── {project-hash}/
        ├── session/
        └── message/

~/.cache/opencode/            ← XDG_CACHE_HOME
├── node_modules/                Installed plugin dependencies
└── models.json                  Cached model list
```

### Environment Variables for Isolation

| Variable                  | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `XDG_CONFIG_HOME`         | Where config, plugins, agents are stored           |
| `XDG_DATA_HOME`           | Where sessions, auth, logs are stored              |
| `XDG_CACHE_HOME`          | Where npm cache, model cache are stored            |
| `XDG_STATE_HOME`          | Where state is stored                              |
| `OPENCODE_CONFIG_DIR`     | Additional config directory (merged, not replaced) |
| `OPENCODE_CONFIG_CONTENT` | Inline JSON config (for runtime injection)         |

**Key insight**: `OPENCODE_CONFIG_DIR` only adds plugins/config, doesn't control data storage. For full isolation, set all XDG variables.

## Architecture Decision: Full Isolation

For Epicenter, we want **full isolation**—OpenCode runs entirely within the app's data folder, separate from any user's standalone OpenCode installation.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  RECOMMENDED: Full Isolation via XDG Variables                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ~/Library/Application Support/Epicenter/     (or %APPDATA%/Epicenter)     │
│  ├── opencode/                                                              │
│  │   ├── config/                              ← XDG_CONFIG_HOME            │
│  │   │   └── opencode/                                                     │
│  │   │       ├── opencode.json                                             │
│  │   │       └── plugin/                                                   │
│  │   │           ├── package.json                                          │
│  │   │           └── epicenter-tools.ts       ← OUR GENERATED PLUGINS     │
│  │   ├── data/                                ← XDG_DATA_HOME              │
│  │   │   └── opencode/                                                     │
│  │   │       ├── auth.json                                                 │
│  │   │       └── project/                     ← sessions                   │
│  │   ├── cache/                               ← XDG_CACHE_HOME             │
│  │   │   └── opencode/                                                     │
│  │   │       └── node_modules/                                             │
│  │   └── state/                               ← XDG_STATE_HOME             │
│  │       └── opencode/                                                     │
│  │                                                                          │
│  └── epicenter/                               ← Epicenter's own data       │
│      ├── workspaces/                                                        │
│      └── registry.json                                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Spawn Command (Rust/Tauri)

```rust
fn spawn_opencode(app_data_dir: &Path, port: u16) -> Result<Child> {
    let opencode_dir = app_data_dir.join("opencode");

    Command::new("opencode")  // or sidecar binary path
        .args(["serve", "--port", &port.to_string()])
        .env("XDG_CONFIG_HOME", opencode_dir.join("config"))
        .env("XDG_DATA_HOME", opencode_dir.join("data"))
        .env("XDG_CACHE_HOME", opencode_dir.join("cache"))
        .env("XDG_STATE_HOME", opencode_dir.join("state"))
        .spawn()
}
```

## Plugin Architecture Options

### The Core Question

How do we give the AI tools to interact with Epicenter's data?

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  OPTION A: Deterministic Generation (One-Way Sync)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Epicenter Schema                                                           │
│  (tables, columns, types)                                                   │
│       │                                                                     │
│       │ Generate at app startup                                            │
│       ▼                                                                     │
│  opencode/config/opencode/plugin/epicenter-tools.ts                        │
│                                                                             │
│  • Schema changes automatically update tools                               │
│  • No user customization of AI tools                                       │
│  • Simpler mental model                                                    │
│  • Tools are always in sync with data model                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  OPTION B: User-Customizable Plugins                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User can add custom plugins via:                                          │
│  • Local .ts files in plugin folder                                        │
│  • npm packages in opencode.json                                           │
│  • UI in Epicenter to browse/install plugins                               │
│                                                                             │
│  • More flexible                                                           │
│  • Requires plugin management UI                                           │
│  • User could break things                                                 │
│  • Sync story more complex                                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  OPTION C: Hybrid (Recommended)                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. Core tools generated from schema (always present)                      │
│  2. Epicenter-published npm plugins (curated)                              │
│  3. User can add additional npm plugins (optional)                         │
│                                                                             │
│  plugin/                                                                   │
│  ├── _generated/                  ← DO NOT EDIT, regenerated on startup   │
│  │   └── epicenter-tools.ts                                                │
│  └── user/                        ← User's custom plugins (optional)      │
│      └── my-custom-tool.ts                                                 │
│                                                                             │
│  opencode.json                                                             │
│  {                                                                         │
│    "plugin": [                                                             │
│      "@epicenter/opencode-plugin",   // Epicenter's curated tools         │
│      "opencode-github-plugin",       // User-installed                    │
│    ]                                                                       │
│  }                                                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Option A Deep Dive: Deterministic Generation

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  FLOW: Schema → Generated Tools                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. App startup                                                            │
│       │                                                                     │
│       ▼                                                                     │
│  2. Read Epicenter workspace configs                                       │
│     (tables, columns, types from epicenter.config.ts)                      │
│       │                                                                     │
│       ▼                                                                     │
│  3. Generate TypeScript plugin file                                        │
│       │                                                                     │
│       ▼                                                                     │
│  4. Write to opencode/config/opencode/plugin/epicenter-tools.ts           │
│       │                                                                     │
│       ▼                                                                     │
│  5. Spawn opencode serve                                                   │
│     (loads generated plugin automatically)                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Example Generated Plugin

Given this Epicenter schema:

```typescript
// epicenter.config.ts
export default defineWorkspace({
	id: 'notes-workspace',
	tables: {
		notes: {
			columns: {
				id: { type: 'string' },
				title: { type: 'string' },
				content: { type: 'string' },
				tags: { type: 'json' }, // string[]
				createdAt: { type: 'date' },
			},
		},
		tags: {
			columns: {
				id: { type: 'string' },
				name: { type: 'string' },
				color: { type: 'string' },
			},
		},
	},
});
```

Generate this plugin:

```typescript
// AUTO-GENERATED - DO NOT EDIT
// Generated from Epicenter workspace schema
// Regenerated on app startup

import { tool } from '@opencode-ai/plugin';
import { z } from 'zod';

// IPC bridge to Epicenter's Rust backend
const epicenterIPC = {
	async query(table: string, filter?: object) {
		return await fetch('http://localhost:EPICENTER_PORT/api/query', {
			method: 'POST',
			body: JSON.stringify({ table, filter }),
		}).then((r) => r.json());
	},
	async mutate(table: string, operation: string, data: object) {
		return await fetch('http://localhost:EPICENTER_PORT/api/mutate', {
			method: 'POST',
			body: JSON.stringify({ table, operation, data }),
		}).then((r) => r.json());
	},
};

export default () => ({
	hooks: {
		tool: {
			// ═══════════════════════════════════════════════════════════
			// TABLE: notes
			// ═══════════════════════════════════════════════════════════

			listNotes: tool({
				description:
					'List all notes, optionally filtered by tags or search query',
				args: z.object({
					search: z.string().optional().describe('Search in title and content'),
					tags: z.array(z.string()).optional().describe('Filter by tags'),
					limit: z.number().optional().default(50),
				}),
				async execute({ search, tags, limit }) {
					return await epicenterIPC.query('notes', { search, tags, limit });
				},
			}),

			getNote: tool({
				description: 'Get a specific note by ID',
				args: z.object({
					id: z.string().describe('Note ID'),
				}),
				async execute({ id }) {
					const results = await epicenterIPC.query('notes', { id });
					return results[0] ?? null;
				},
			}),

			createNote: tool({
				description: 'Create a new note',
				args: z.object({
					title: z.string().describe('Note title'),
					content: z.string().describe('Note content (markdown)'),
					tags: z.array(z.string()).optional().describe('Tags to apply'),
				}),
				async execute({ title, content, tags }) {
					return await epicenterIPC.mutate('notes', 'create', {
						title,
						content,
						tags,
						createdAt: new Date().toISOString(),
					});
				},
			}),

			updateNote: tool({
				description: 'Update an existing note',
				args: z.object({
					id: z.string().describe('Note ID'),
					title: z.string().optional(),
					content: z.string().optional(),
					tags: z.array(z.string()).optional(),
				}),
				async execute({ id, ...updates }) {
					return await epicenterIPC.mutate('notes', 'update', {
						id,
						...updates,
					});
				},
			}),

			deleteNote: tool({
				description: 'Delete a note',
				args: z.object({
					id: z.string().describe('Note ID'),
				}),
				async execute({ id }) {
					return await epicenterIPC.mutate('notes', 'delete', { id });
				},
			}),

			// ═══════════════════════════════════════════════════════════
			// TABLE: tags
			// ═══════════════════════════════════════════════════════════

			listTags: tool({
				description: 'List all available tags',
				args: z.object({}),
				async execute() {
					return await epicenterIPC.query('tags', {});
				},
			}),

			createTag: tool({
				description: 'Create a new tag',
				args: z.object({
					name: z.string().describe('Tag name'),
					color: z.string().optional().describe('Tag color (hex)'),
				}),
				async execute({ name, color }) {
					return await epicenterIPC.mutate('tags', 'create', { name, color });
				},
			}),
		},
	},
});
```

### Generator Implementation (Conceptual)

```typescript
// packages/epicenter/src/opencode/generate-plugin.ts

export function generateOpenCodePlugin(workspaces: WorkspaceConfig[]): string {
	const tools: string[] = [];

	for (const workspace of workspaces) {
		for (const [tableName, tableConfig] of Object.entries(workspace.tables)) {
			tools.push(generateListTool(tableName, tableConfig));
			tools.push(generateGetTool(tableName, tableConfig));
			tools.push(generateCreateTool(tableName, tableConfig));
			tools.push(generateUpdateTool(tableName, tableConfig));
			tools.push(generateDeleteTool(tableName, tableConfig));
		}
	}

	return `
// AUTO-GENERATED - DO NOT EDIT
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";

${generateIPCBridge()}

export default () => ({
  hooks: {
    tool: {
${tools.join('\n\n')}
    },
  },
});
`;
}

function generateListTool(tableName: string, config: TableConfig): string {
	const singularName = singularize(tableName);
	const pascalName = pascalCase(tableName);

	return `
      list${pascalName}: tool({
        description: "List all ${tableName}",
        args: z.object({
          limit: z.number().optional().default(50),
          ${generateFilterArgs(config)}
        }),
        async execute(args) {
          return await epicenterIPC.query('${tableName}', args);
        },
      }),`;
}
```

## How This Fits with Epicenter's Data Model

### Current Data Structures

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  EPICENTER DATA MODEL                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Registry Document                                                         │
│  └── Lists all workspace configs                                           │
│      └── Each workspace has: id, tables, columns, types                    │
│                                                                             │
│  Head Document                                                             │
│  └── Current state pointer                                                 │
│                                                                             │
│  Workspace Documents (YDoc)                                                │
│  └── Actual data in Y.Map structures                                       │
│      └── Tables → Rows → Cells (CRDT)                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Integration Points

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  INTEGRATION ARCHITECTURE                                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐                                                       │
│  │  Registry Doc   │──────────────────┐                                    │
│  │  (workspace     │                  │                                    │
│  │   schemas)      │                  │                                    │
│  └─────────────────┘                  │                                    │
│           │                           │                                    │
│           │ Read schemas              │ Generate tools from schemas        │
│           ▼                           ▼                                    │
│  ┌─────────────────┐         ┌─────────────────┐                          │
│  │  Epicenter      │         │  OpenCode       │                          │
│  │  Rust Backend   │◄───────►│  Plugin         │                          │
│  │                 │  HTTP   │  (generated)    │                          │
│  └─────────────────┘         └─────────────────┘                          │
│           │                           │                                    │
│           │                           │                                    │
│           ▼                           ▼                                    │
│  ┌─────────────────┐         ┌─────────────────┐                          │
│  │  Workspace Docs │         │  OpenCode       │                          │
│  │  (YDoc/CRDT)    │         │  Sessions       │                          │
│  │                 │         │  (JSON files)   │                          │
│  └─────────────────┘         └─────────────────┘                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Plugin Synchronization Across Devices

### The Problem

If users can customize plugins, how do we sync them across devices?

### Option 1: Don't Sync Plugins (Simplest)

```
Device A                              Device B
┌─────────────────┐                  ┌─────────────────┐
│ Generated tools │                  │ Generated tools │
│ (from schema)   │◄────────────────►│ (from schema)   │
│                 │   Schema syncs   │                 │
│ User plugins    │      via YJS     │ User plugins    │
│ (local only)    │                  │ (local only)    │
└─────────────────┘                  └─────────────────┘

• Schema syncs → tools regenerate identically on each device
• User plugins are device-local (not synced)
• Simple, but user loses custom plugins on new device
```

### Option 2: Store Plugin Config in Workspace

```typescript
// In epicenter.config.ts or a dedicated workspace
export default defineWorkspace({
	id: 'epicenter-settings',
	tables: {
		opencode_plugins: {
			columns: {
				id: { type: 'string' },
				type: { type: 'string' }, // 'npm' | 'local'
				source: { type: 'string' }, // npm package name or local path
				enabled: { type: 'boolean' },
			},
		},
	},
});
```

```
Device A                              Device B
┌─────────────────┐                  ┌─────────────────┐
│ opencode_plugins│◄────────────────►│ opencode_plugins│
│ table (YJS)     │   Syncs via YJS  │ table (YJS)     │
└────────┬────────┘                  └────────┬────────┘
         │                                    │
         │ Read on startup                    │ Read on startup
         ▼                                    ▼
┌─────────────────┐                  ┌─────────────────┐
│ opencode.json   │                  │ opencode.json   │
│ (generated)     │                  │ (generated)     │
│                 │                  │                 │
│ { "plugin": [   │                  │ { "plugin": [   │
│   "@foo/bar",   │                  │   "@foo/bar",   │
│   "@baz/qux"    │                  │   "@baz/qux"    │
│ ]}              │                  │ ]}              │
└─────────────────┘                  └─────────────────┘

• Plugin list stored in Epicenter (syncs via YJS)
• opencode.json generated from this list on startup
• npm plugins installed automatically by OpenCode
```

### Option 3: Sync Plugin Files via Epicenter

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Store plugin source code in Epicenter                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  opencode_plugins table:                                                   │
│  ┌──────────┬──────────┬─────────────────────────────┐                    │
│  │ id       │ name     │ source_code                 │                    │
│  ├──────────┼──────────┼─────────────────────────────┤                    │
│  │ plugin-1 │ my-tool  │ "export default () => ..." │                    │
│  └──────────┴──────────┴─────────────────────────────┘                    │
│                                                                             │
│  On startup:                                                               │
│  1. Read opencode_plugins table                                            │
│  2. Write each plugin's source_code to plugin/ folder                     │
│  3. Spawn opencode serve                                                   │
│                                                                             │
│  Pros: Full sync of custom plugins                                         │
│  Cons: Storing code in database is weird, security concerns                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Recommended Approach (Phase 1)

Start simple, expand later.

### Phase 1: Deterministic Generation Only

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  PHASE 1: MVP                                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  • Full XDG isolation (OpenCode data in app folder)                        │
│  • Generate tools from Epicenter schema at startup                         │
│  • No user-customizable plugins (yet)                                      │
│  • Single port (4096), restart server on schema change                     │
│                                                                             │
│  User Experience:                                                          │
│  1. User opens Epicenter                                                   │
│  2. OpenCode server starts automatically                                   │
│  3. AI has tools matching their current workspace schema                   │
│  4. Schema changes? App regenerates tools and restarts server             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 2: Curated Epicenter Plugins

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  PHASE 2: Official Plugins                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  • Publish @epicenter/opencode-plugin to npm                               │
│  • Contains curated tools: web search, file operations, etc.               │
│  • Users can enable/disable in settings UI                                 │
│  • Plugin list stored in Epicenter settings (syncs)                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 3: User-Installable Plugins

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  PHASE 3: Plugin Marketplace                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  • UI to browse/install community plugins                                  │
│  • Plugin list syncs across devices                                        │
│  • Security review process for listed plugins                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Implementation Todo

### Phase 1 Tasks

- [ ] Create `packages/epicenter/src/opencode/` module
- [ ] Implement XDG-isolated OpenCode spawner
- [ ] Build schema-to-plugin generator
- [ ] Add IPC endpoints in Rust backend for plugin queries/mutations
- [ ] Wire up OpenCode server lifecycle to app lifecycle
- [ ] Build basic chat UI that talks to OpenCode HTTP API
- [ ] Handle schema changes (regenerate + restart)

### Open Questions

1. **Binary distribution**: Bundle OpenCode as sidecar, or require user to install?
   - Sidecar: ~50MB binary size increase, but "just works"
   - User install: Smaller app, but dependency on user action

2. **Port management**: Fixed port (4096) or random?
   - Fixed: Can detect/reuse existing server
   - Random: No conflicts, but harder to reconnect

3. **Auth flow**: Use OpenCode's auth.json, or proxy through Epicenter?
   - OpenCode auth: User configures once, shared with CLI
   - Epicenter proxy: Unified settings UI, but more work

4. **Session persistence**: Should chat sessions live in OpenCode or Epicenter?
   - OpenCode: Already built, but separate from Epicenter data
   - Epicenter: Unified, but need to build session management

## References

- [sst/opencode GitHub](https://github.com/sst/opencode)
- [OpenCode Documentation](https://opencode.ai/docs/)
- [OpenCode Plugin System](https://opencode.ai/docs/plugins/)
- [OpenCode CLI Commands](https://opencode.ai/docs/cli/)

## Appendix: OpenCode API Endpoints

```
GET  /health                    Health check
GET  /session                   List sessions
POST /session                   Create session
GET  /session/:id               Get session
POST /session/:id/message       Send message
GET  /events                    SSE stream for real-time updates
POST /auth/set                  Set provider auth programmatically
```

## Appendix: Environment Variable Reference

```bash
# Full isolation
XDG_CONFIG_HOME=/path/to/app/opencode/config
XDG_DATA_HOME=/path/to/app/opencode/data
XDG_CACHE_HOME=/path/to/app/opencode/cache
XDG_STATE_HOME=/path/to/app/opencode/state

# Runtime config injection
OPENCODE_CONFIG_CONTENT='{"provider":{"anthropic":{"options":{"apiKey":"..."}}}}'

# Additional config directory (merged, not replaced)
OPENCODE_CONFIG_DIR=/path/to/extra/config
```
