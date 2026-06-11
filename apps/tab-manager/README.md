# Tab Manager

Live tabs and saved tabs are fundamentally different things. Live tabs mirror Chrome's reality. They're ephemeral, they vanish on restart, and they're not yours to own. Saved tabs and bookmarks are workspace data: they persist, sync across devices, and survive browser restarts. Tab Manager is a browser extension that keeps these two layers separate and bridges them with an AI chat drawer that can act on your workspace.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. MIT licensed.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│  WXT Side Panel (Svelte app)                     │
├──────────────────────────────────────────────────┤
│  Chrome APIs (tabs, windows, identity)           │
├──────────────┬───────────────────────────────────┤
│  Browser     │  Workspace state (saved tabs,     │
│  state       │  bookmarks, chat, tool trust)     │
│  (ephemeral) │  @epicenter/workspace + sync      │
├──────────────┴───────────────────────────────────┤
│  @epicenter/workspace/ai (AI tool bridge)        │
└──────────────────────────────────────────────────┘
```

The extension never fights Chrome for ownership of tab state. Ephemeral state seeds from `chrome.windows.getAll` and stays current via event listeners. Workspace state persists to IndexedDB, syncs over WebSocket, and replicates to every device you sign into.

---

## How it works

### Browser state

On load, `browser-state.svelte.ts` seeds a reactive map of every open window and tab. Chrome's tab and window event listeners keep it current. This layer exposes actions: close, activate, pin, mute, reload, and duplicate. They are all backed by Chrome APIs. Nothing here persists; it's a mirror.

### Workspace state

Saved tabs and bookmarks live in Epicenter workspace tables and sync across devices over WebSocket. The UI reads from these tables via `fromTable` and writes through workspace actions. Save a tab on your laptop and it shows up on your desktop.

### Side panel

A Svelte app mounted into `#app`. There's no popup and no content scripts. Everything runs in the side panel, which opens when you click the extension action button. The background service worker is minimal; its only job is to open the side panel on click.

### UI

The main UI has a search bar with case-sensitive, regex, and exact-match toggles; a unified tab list that shows open tabs grouped by window alongside saved tabs and bookmarks in a single virtualized list; per-tab actions; a command palette for bulk operations (dedupe, group by domain, sort, close by domain, save all); and a sync status indicator.

---

## Workspace schema

Workspace ID: `epicenter-tab-manager`. Six tables:

| Table | Key | Notable fields |
|---|---|---|
| `devices` | `DeviceId` | `name`, `lastSeen`, `browser` |
| `savedTabs` | `SavedTabId` | `url`, `title`, `favIconUrl?`, `pinned`, `sourceDeviceId`, `savedAt` |
| `bookmarks` | `BookmarkId` | `url`, `title`, `favIconUrl?`, `description?`, `sourceDeviceId`, `createdAt` |
| `conversations` | `ConversationId` | `title`, `parentId?`, `systemPrompt?`, `provider`, `model`, `createdAt`, `updatedAt` |
| `chatMessages` | `ChatMessageId` | `conversationId`, `role`, `parts[]`, `createdAt` |
| `toolTrust` | tool name | `trust: 'ask' \| 'always'` |

Awareness entries carry `{ deviceId, client: "extension" | "desktop" | "cli" }` so you can see which devices are currently connected.

---

## AI chat

The `AiDrawer` component is a sign-in-gated chat drawer that supports multiple conversations. Chat streams via SSE from the configured remote server. Workspace actions are converted to AI tools via `@epicenter/workspace/ai`'s `actionsToAiTools`, so the AI can read and write workspace data directly.

Destructive tool calls require inline approval before they execute. Each tool can also be set to "always allow," and that preference is stored in the `toolTrust` table, so it syncs across all your devices like any other workspace data.

---

## Development

Prerequisites: [Bun](https://bun.sh).

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
bun dev
```

From the repo root, `bun dev` starts the local API and the WXT extension dev server. To work on only the extension UI, run:

```bash
bun run dev:tab-manager:ui
```

To load the extension in Chrome: open `chrome://extensions`, enable Developer Mode, click "Load unpacked," and select the `apps/tab-manager/.output/chrome-mv3-dev` directory.

From inside `apps/tab-manager`, `bun dev` starts WXT only. Use that when `bun run dev:api` is already running from the repo root, or when you are intentionally testing UI-only behavior.


Firefox:

```bash
bun run dev:firefox
```

To build for distribution:

```bash
bun run build          # Chrome
bun run zip            # Package for Chrome Web Store
bun run zip:firefox    # Package for Firefox Add-ons
```

Auth uses Google OAuth via `browser.identity`. Encryption keys are applied on login.

---

## Tech stack

- [WXT](https://wxt.dev): browser extension framework
- [Svelte 5](https://svelte.dev): UI (side panel)
- [Yjs](https://yjs.dev): CRDT engine
- [virtua](https://github.com/inokawa/virtua): virtualized tab list
- [Tailwind CSS](https://tailwindcss.com): styling
- `@epicenter/workspace`: CRDT-backed tables, sync, persistence
- `@epicenter/workspace/ai` - workspace-to-LLM tool bridge
- `@epicenter/svelte`: auth integration
- `@epicenter/ui`: shadcn-svelte component library

---

## License

MIT
