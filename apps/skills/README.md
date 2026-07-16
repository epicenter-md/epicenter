# Skills Editor

A local browser editor for Epicenter agent skills. Records live in the Browser
workspace runtime's canonical OPFS store. Instructions and reference bodies are
parameterized Yjs documents persisted in IndexedDB. No remote synchronization is
wired in, so the editor works entirely offline.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo.
AGPL-3.0 licensed.

## Workspace composition

`src/lib/skills/client.ts` creates the Browser runtime and opens the inert
`skillsWorkspace` definition from `@epicenter/skills`. Record lenses validate
canonical JSON when it is read. Rows that do not conform stay stored and appear
in the UI's invalid-record count rather than being silently deleted or migrated.

The app uses runtime-owned structural record IDs. Each valid skill and reference
also carries a stable `sourceId` in its JSON payload for domain-level references.
Deleting a skill explicitly deletes its currently conforming reference records.
Its persisted document rooms are retained; releasing an editor only unloads the
live document lease.

Instructions and reference bodies are top-level parameterized documents:

```ts
await skills.documents.instructions.open({ skillId });
await skills.documents.reference.open({ referenceId });
```

Application code never constructs room IDs, GUIDs, authority identities, or
document providers. The runtime derives and owns them.

## UI

The single route renders a resizable split view with a searchable skill list,
metadata editor, Markdown instructions editor, references panel, and command
palette. CodeMirror writes document content through the typed document handle.

## Development

The Browser OPFS runtime requires a cross-origin isolated page. The SvelteKit
server hook and Vite dev and preview servers set the required COOP and COEP
headers. Production proxies must preserve those headers.

From the repository root:

```bash
bun install
bun dev:skills
```

Run checks with:

```bash
bun run --filter skills typecheck
bun run --filter skills build
```

## License

AGPL-3.0
