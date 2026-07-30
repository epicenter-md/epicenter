# Tab Manager

Live tabs and saved tabs are fundamentally different things. Live tabs mirror Chrome's reality. They're ephemeral, they vanish on restart, and they're not yours to own. Saved tabs and bookmarks are yours: they persist, sync across devices, and survive browser restarts. Tab Manager is a browser extension that keeps these two layers separate and bridges them with an AI chat drawer that can act on the durable one.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│  WXT Side Panel (Svelte app)  ← owns the replica  │
├──────────────────────────────────────────────────┤
│  Chrome APIs (tabs, windows, identity)           │
├──────────────┬───────────────────────────────────┤
│  Browser     │  Durable rows (saved tabs,        │
│  state       │  bookmarks, chat, tool trust)     │
│  (ephemeral) │  tabManagerLens + @epicenter/data │
├──────────────┴───────────────────────────────────┤
│  DedicatedWorker: OPFS SQLite + one Web Lock     │
└──────────────────────────────────────────────────┘
```

**Ownership, in one sentence: the open side panel document owns one Epicenter
browser replica, and the background service worker owns no database.**

That is not a preference. `openBrowserEpicenter` spawns a DedicatedWorker that
claims one exclusive Web Lock over one OPFS SQLite file, and the replica belongs
to the storage-partition and origin pair of the document that opened it
(ADR-0165, amended by ADR-0177). MV3 gives a background service worker no
production lifetime guarantee, so a replica owned there would lose its lock to
termination at a moment nothing observes. The background entrypoint's only job
is to open the side panel on action click, and `ownership.test.ts` asserts its
module graph can never reach a replica.

A consequence worth knowing: a second same-partition extension document is
refused immediately rather than queued, so opening the side panel in a second
browser window surfaces "already open in another tab for this origin" instead of
waiting on the first one's lifetime. There is deliberately no election, broker,
or handoff protocol.

The extension never fights Chrome for ownership of tab state. Ephemeral state
seeds from `chrome.windows.getAll` and stays current via event listeners.
Durable rows live in SQLite and sync over HTTP when you are signed in.

---

## How it works

### Browser state

On load, `browser-state.svelte.ts` seeds a reactive map of every open window and tab. Chrome's tab and window event listeners keep it current. This layer exposes actions: close, activate, pin, mute, reload, and duplicate. They are all backed by Chrome APIs. Nothing here persists; it's a mirror.

### Durable rows

Saved tabs and bookmarks are rows in this origin's replica and sync across
devices. The UI reads them through `fromTable`, which subscribes before it reads
and then re-reads only the rows an invalidation names (ADR-0187), and writes
through the capability registry in `lib/actions.ts`. Save a tab on your laptop
and it shows up on your desktop.

Row ids are minted by the runtime, so nothing here authors an `id`. A device is
named by a `nodeId` field instead, kept in `chrome.storage.local` so it stays
stable across panel opens and sign-ins.

### Side panel

A Svelte app mounted into `#app`. There's no popup and no content scripts.
Everything runs in the side panel, which opens when you click the extension
action button. `App.svelte` starts exactly one acquisition
(`openTabManagerApplication`) and renders it through one `{#await}`; closing the
panel aborts it, which releases the worker, the Web Lock, and the OPFS handles.
Every library module stays inert at import so a storage failure lands in a
mounted error boundary instead of blanking the document.

### UI

The main UI has a search bar with case-sensitive, regex, and exact-match toggles; a unified tab list that shows open tabs grouped by window alongside saved tabs and bookmarks in a single virtualized list; per-tab actions; a command palette for bulk operations (dedupe, group by domain, sort, close by domain, save all); and a sync status indicator.

---

## Lens

Namespace: `so.epicenter.tab-manager`, declared once in `src/lib/workspace/index.ts`
and bound by whichever runtime opened the replica. Five tables, every row id
minted by the runtime:

| Table | Fields |
|---|---|
| `devices` | `nodeId`, `name`, `lastSeen`, `browser` |
| `savedTabs` | `url`, `title`, `favIconUrl?`, `pinned`, `sourceNodeId`, `savedAt` |
| `bookmarks` | `url`, `title`, `favIconUrl?`, `sourceNodeId`, `createdAt` |
| `conversations` | `title`, `model`, `createdAt`, `updatedAt` |
| `toolTrust` | `toolName` (one row per "always allow" grant) |

`conversations` is the canonical shape from `@epicenter/chat`, interpreted under
this namespace rather than borrowed from another application's (ADR-0160).
Conversation messages live in the per-row document, not a table.

`toolTrust` is one row per grant rather than one value holding a list, so two
devices granting two different tools at once keep both grants. `sourceNodeId`
points at a device's `nodeId`, which is why that is a field and not the row id.

Live browser tabs, windows, and tab groups are absent on purpose. Chrome owns
them, and `workspace.test.ts` asserts they never became durable.

---

## AI chat

The `AiDrawer` component supports multiple conversations. Chat inference needs a signed-in remote connection, but the drawer and its local conversation metadata do not gate the extension shell. The same capability registry the UI calls is projected into the agent's tool surface by `createLocalToolCatalog` from `@epicenter/agent`, so a tool call and a button press take the same path.

Destructive tool calls require inline approval before they execute: a query runs unattended, a mutation asks. Each tool can also be set to "always allow," and that grant is a `toolTrust` row, so it syncs across your devices like any other row.

---

## Development

Prerequisites: [Bun](https://bun.sh).

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
bun dev:tab-manager
```

From the repo root, `bun dev:tab-manager` starts the local API and the WXT extension dev server. Bare `bun dev` currently aliases this default workflow. To work on only the extension UI, run:

```bash
bun dev:tab-manager:ui
```

To load the extension in Chrome: open `chrome://extensions`, enable Developer Mode, click "Load unpacked," and select the `apps/tab-manager/.output/chrome-mv3-dev` directory.

The package-local `bun dev` still starts WXT only, but the root commands are the preferred dev entrypoints.


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

Auth uses OAuth via `browser.identity`. Sign-in is an enhancement, never a door (ADR-0088): the replica is the same one either way, and signing in attaches a sync session to the replica already open rather than swapping storage or reloading the panel.

---

## Tech stack

- [WXT](https://wxt.dev): browser extension framework
- [Svelte 5](https://svelte.dev): UI (side panel)
- [virtua](https://github.com/inokawa/virtua): virtualized tab list
- [Tailwind CSS](https://tailwindcss.com): styling
- `@epicenter/data`: the replica, its Lens binding, and row documents
- `@epicenter/chat`: the canonical `conversations` shape
- `@epicenter/agent` `createLocalToolCatalog`: capabilities to agent tools
- `@epicenter/document-sync`: HTTP document transports
- `@epicenter/svelte`: `fromTable` and auth integration
- `@epicenter/ui`: shadcn-svelte component library

---

## License

AGPL-3.0
