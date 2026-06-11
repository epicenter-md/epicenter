# Handoff: Execute `epicenter size` CLI Command Spec

## Task

Execute the spec at `specs/20260405T101228-epicenter-size-command.md`. This adds an `epicenter size` command that reports encoded byte size and per-table row counts for all workspaces in a config. Three files touched: one new, two modified.

## Context

### How CLI commands work in this codebase

Every command follows this pattern:

1. Define a command object with `defineCommand()` (identity function for type narrowing)
2. Use `withWorkspaceOptions(y)` to add `--dir`, `--workspace`, `--format` flags
3. Use `runCommand(opts, fn, format)` for single-workspace commands: it handles loadConfig → resolve → whenReady → execute → dispose

**However, this command is different.** It needs to show ALL workspaces, not just one. So it uses `loadConfig()` directly instead of `runCommand()`.

### The existing `describe` command (simplest template)

```typescript
// packages/cli/src/commands/describe.ts: full file
import { describeWorkspace } from '@epicenter/workspace';
import type { Argv } from 'yargs';
import {
	defineCommand,
	runCommand,
	withWorkspaceOptions,
} from '../util/command';

export const describeCommand = defineCommand({
	command: 'describe',
	describe: 'Describe workspace schema, actions, and KV definitions',
	builder: (y: Argv) => withWorkspaceOptions(y),
	handler: async (argv: any) => {
		await runCommand(
			{ dir: argv.dir, workspaceId: argv.workspace },
			(client) => describeWorkspace(client),
			argv.format,
		);
	},
});
```

### How loadConfig works

```typescript
// packages/cli/src/load-config.ts
import type { AnyWorkspaceClient } from '@epicenter/workspace';

export type LoadConfigResult = {
	configDir: string;
	clients: AnyWorkspaceClient[];
};

export async function loadConfig(targetDir: string): Promise<LoadConfigResult> {
	// imports epicenter.config.ts via Bun
	// collects all named exports that are workspace clients (duck-type check)
	// deduplicates by workspace ID
	// throws if no config file or no valid exports
	return { configDir, clients };
}
```

### How the export command iterates tables (pattern to follow)

```typescript
// packages/cli/src/commands/data.ts (exportCommand handler)
(client) => {
	const data: Record<string, unknown[]> = {};
	const tableNames = argv.table
		? [argv.table as string]
		: Object.keys(client.definitions.tables);

	for (const tableName of tableNames) {
		const table = client.tables[tableName];
		if (!table) {
			throw new Error(`Table "${tableName}" not found in workspace "${client.id}"`);
		}
		data[tableName] = table.getAllValid();
	}
	return data;
}
```

### Key workspace client APIs

```typescript
client.id                              // string: workspace ID
client.encodedSize()                   // number: total Y.Doc byte size
client.definitions.tables              // Record<string, TableDefinition>: table schemas
client.tables[name].count()            // number: row count (valid + invalid)
client.whenReady                       // Promise<void>: resolves when extensions init'd
client.dispose()                       // Promise<void>: cleanup
```

### How output utilities work

```typescript
// packages/cli/src/util/format-output.ts
export function output(value: unknown, options?: { format?: 'json' | 'jsonl' }): void;
export function outputError(message: string): void;
export function formatYargsOptions(): { format: { type: 'string', choices: ['json', 'jsonl'] } };
```

### How commands are registered

```typescript
// packages/cli/src/cli.ts: add one line in the .command() chain
import { sizeCommand } from './commands/size';
// ...
.command(sizeCommand)
```

### Current CLI README structure

The README at `packages/cli/src/README.md` has sections for Command Structure (full bash listing), Table Commands, KV Commands, Action Commands, Output Formats, Working Directory, and Multiple Workspaces.

## Design Requirements

### 1. `packages/cli/src/commands/size.ts` (NEW FILE)

Create `sizeCommand` that:

- Uses `loadConfig(dir)` directly (NOT `runCommand`) so it can iterate all clients
- Accepts `--workspace` to optionally filter to one workspace
- Accepts `--dir` / `-C` for project directory
- Accepts `--format json` for machine-readable output
- For each client: awaits `whenReady`, calls `encodedSize()`, iterates `Object.keys(client.definitions.tables)` calling `.count()` on each
- Disposes ALL clients in a `finally` block (same pattern as `runCommand`)
- Catches errors and calls `outputError()` + sets `process.exitCode = 1` (same pattern as `runCommand`)

**Human-readable output** (default, when no `--format`):

```
blog (14.2 KB)
  posts        12 rows
  comments     47 rows
  tags          5 rows

shop (8.7 KB)
  products     23 rows
  orders       91 rows
```

- Format bytes as human-readable (B, KB, MB) with 1 decimal place
- Right-align row counts within each workspace
- Separate workspaces with blank lines
- Print to stdout via `console.log()`

**JSON output** (when `--format json`):

```json
[
  {
    "id": "blog",
    "encodedSize": 14532,
    "tables": {
      "posts": { "rows": 12 },
      "comments": { "rows": 47 }
    }
  }
]
```

- Use `output(result, { format: argv.format })` for JSON mode
- Raw byte counts (numbers, not formatted strings)

### 2. `packages/cli/src/cli.ts` (MODIFY)

- Add import: `import { sizeCommand } from './commands/size';`
- Add `.command(sizeCommand)` in the chain (put it near `describeCommand` since they're both introspection commands)

### 3. `packages/cli/src/README.md` (MODIFY)

- Add `epicenter size` to the Command Structure section
- Add a brief "Size Commands" section showing usage examples

## MUST DO

- Follow the exact error handling pattern from `runCommand`: wrap in try/catch, call `outputError(err.message)`, set `process.exitCode = 1`
- Follow the exact dispose pattern: `await Promise.all(clients.map((c) => c.dispose()))` in a `finally` block
- Use `withWorkspaceOptions(y)` for the builder to get `--dir`, `--workspace`, `--format` flags
- Use `type` instead of `interface` for any TypeScript types
- Keep the byte formatting function simple and inline (no new dependencies)
- Include JSDoc on the exported `sizeCommand` with `@example` blocks showing bash usage
- When `--workspace` is specified and not found, throw an error listing available IDs (same UX as `resolveWorkspace`)
- Load the `monorepo` skill to find the right type-check command for verification

## MUST NOT DO

- Do not use `runCommand`: it resolves to a single client, but we need all clients
- Do not install any new dependencies
- Do not modify any files outside of `packages/cli/`
- Do not add per-table byte sizes (not available from the Yjs API)
- Do not use `interface`: use `type` for all TypeScript types
- Do not use `as any` or `@ts-ignore`
- Do not create test files (out of scope for this spec)
