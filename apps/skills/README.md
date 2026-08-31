# Skills Editor

A local browser editor for Epicenter agent skills. Records live in the Browser
workspace runtime's canonical OPFS store. Instructions and reference bodies are
the `content` nodes on their owning rows in the workspace document. CodeMirror
binds directly to those live nodes.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo.
AGPL-3.0 licensed.

## Workspace composition

The mounted root layout calls `openSkillsApplication()`, renders its stable boot
promise with Svelte's `{#await}` block, and provides only the fully opened and
hydrated application to descendants. Importing Skills modules does not open
storage. The workspace declaration validates canonical JSON when it is read. Rows that do not
conform stay stored and appear in the UI's invalid-record count rather than
being silently deleted or migrated.

The app uses runtime-owned structural record IDs. Each valid skill and reference
also carries a stable `sourceId` in its JSON payload for domain-level references.
Deleting a skill explicitly deletes its currently conforming reference records.
Deleting a row also removes its content node, which is nested under it.

Instructions and reference bodies are rich fields on their owning rows:

```ts
skills.data.tables.skills.get(skillId)?.content;
skills.data.tables.skillReferences.get(referenceId)?.content;
```

Application code never constructs addresses, authority identities, or providers.
There is one document, and the runtime owns it.

## UI

The single route renders a resizable split view with a searchable skill list,
metadata editor, Markdown instructions editor, references panel, and command
palette. CodeMirror binds directly to the row's `content` field.

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
