# Single Workspace Simplification

**Date**: 2026-02-02
**Status**: ✅ Implemented
**Author**: CLI Team

## Implementation Summary

The single workspace simplification has been completed with several enhancements beyond the original plan:

### What Was Implemented

1. **Single client architecture**: `createCLI()` now takes a single `AnyWorkspaceClient` instead of arrays
2. **Default export convention**: `export default createWorkspaceClient({...})` is the new standard
3. **Backward compatibility**: Named exports still work with validation (only one allowed)
4. **Smart discovery**: New `resolveWorkspace()` function with discriminated union return type
5. **Ambiguity detection**: Helpful messages when configs exist in subdirectories
6. **`-C`/`--dir` flag**: Run commands from parent directories without `cd`
7. **Robust error handling**: Using `tryAsync` from wellcrafted throughout
8. **Path normalization**: Cross-platform path handling improvements

### Key Files Modified

- `discovery.ts`: New `resolveWorkspace()` API, default export support, ambiguity detection
- `cli.ts`: Single client signature, removed array handling
- `bin.ts`: `-C`/`--dir` flag parsing, `tryAsync` integration
- `index.ts`: Updated exports
- `README.md`: Updated documentation
- All command builders: Simplified to single client

### User Experience Improvements

**Before (multi-workspace mode):**
```bash
epicenter blog posts list
epicenter shop products list
```

**After (single workspace with `-C` flag):**
```bash
cd blog && epicenter posts list
# or
epicenter -C blog posts list
epicenter -C shop products list
```

With smart error messages when running from wrong directory:
```
No epicenter.config.ts found in current directory.

Found configs in subdirectories:
  - blog/epicenter.config.ts
  - shop/epicenter.config.ts

Use -C <dir> to specify which project:
  epicenter -C blog posts list
```

---

## Original Plan Overview

The Epicenter CLI originally supported both single and multi-workspace modes via auto-detection:
- 1 `WorkspaceClient` export = single mode: `epicenter posts list`
- N `WorkspaceClient` exports = multi mode: `epicenter blog posts list`

We removed multi-workspace support entirely. **One config file = one workspace.**

### Rationale

1. **Complexity reduction**: The discriminated union (`SingleClientConfig | MultiClientConfig`) adds conditional logic throughout the codebase
2. **Simpler mental model**: Users don't need to understand when commands get prefixed
3. **Clearer error messages**: No ambiguity about command structure
4. **Multiple workspaces still possible**: Use separate directories with separate config files or `-C` flag

## Files Affected

| File | Changes |
|------|---------|
| `discovery.ts` | Remove `MultiClientConfig`, simplify `loadClients` to `loadClient` |
| `cli.ts` | Take single client, remove array iteration |
| `table-commands.ts` | Remove conditional command path |
| `kv-commands.ts` | Remove conditional command path |
| `meta-commands.ts` | Remove `workspaces` command, simplify `tables` handler |
| `index.ts` | Update exports |
| `README.md` | Remove multi-workspace documentation |

---

## 1. Code Deletions

### 1.1 Type Definitions (discovery.ts)

**Delete entirely:**

```ts
// DELETE: Multi client mode type
export type MultiClientConfig = {
  mode: 'multi';
  clients: AnyWorkspaceClient[];
};

// DELETE: Discriminated union
export type CommandConfig = SingleClientConfig | MultiClientConfig;
```

### 1.2 Mode Detection Logic (discovery.ts)

**Delete:**

```ts
// DELETE: createCommandConfig function
export function createCommandConfig(clients: AnyWorkspaceClient[]): CommandConfig {
  if (clients.length === 0) {
    throw new Error('At least one client required');
  }
  if (clients.length === 1) {
    return { mode: 'single', clients: [clients[0]!] as const };
  }
  return { mode: 'multi', clients };
}
```

### 1.3 Multi-Client Conditionals (throughout)

**Delete all `config.mode === 'single'` / `config.mode === 'multi'` checks:**

```ts
// DELETE: In meta-commands.ts tables handler
if (config.mode === 'single') {
  const tableNames = Object.keys(config.clients[0]!.tables);
  output(tableNames, { format: argv.format as any });
} else {
  const result: Record<string, string[]> = {};
  for (const client of config.clients) {
    result[client.id] = Object.keys(client.tables);
  }
  output(result, { format: argv.format as any });
}

// DELETE: In table-commands.ts
const commandPath =
  config.mode === 'single'
    ? tableName
    : `${client.id} ${tableName}`;

// DELETE: In kv-commands.ts
const commandPath = config.mode === 'single' ? 'kv' : `${client.id} kv`;
```

### 1.4 Workspaces Command (meta-commands.ts)

**Delete entirely:**

```ts
// DELETE: workspaces command
commands.push({
  command: 'workspaces',
  describe: 'List all workspaces',
  builder: (yargs) => yargs.options(formatYargsOptions()),
  handler: (argv) => {
    const ids = config.clients.map((c) => c.id);
    output(ids, { format: argv.format as any });
  },
});
```

### 1.5 Workspace Name Validation (cli.ts)

**Delete:**

```ts
// DELETE: Multi-client workspace name validation
if (!isSingleClient && isReservedCommand(client.id)) {
  console.warn(
    `Warning: Workspace "${client.id}" conflicts with reserved command. ` +
      `Reserved commands: ${RESERVED_COMMANDS.join(', ')}`,
  );
}
```

### 1.6 Client Array Iteration (cli.ts)

**Delete:**

```ts
// DELETE: Array normalization
const clientArray = Array.isArray(clients) ? clients : [clients];

// DELETE: Loops over clientArray
for (const client of clientArray) {
  await client.destroy();
}
```

### 1.7 Reserved Command (meta-commands.ts)

**Delete from RESERVED_COMMANDS:**

```ts
// BEFORE
export const RESERVED_COMMANDS = [
  'serve',
  'tables',
  'workspaces',  // <-- DELETE THIS
  'kv',
  'help',
  'version',
  'init',
] as const;

// AFTER
export const RESERVED_COMMANDS = [
  'serve',
  'tables',
  'kv',
  'help',
  'version',
  'init',
] as const;
```

### 1.8 Exports (index.ts)

**Delete:**

```ts
// DELETE from exports
type MultiClientConfig,
type SingleClientConfig,
type CommandConfig,
createCommandConfig,
loadClients,  // renamed to loadClient
```

---

## 2. Actual Implementation

### 2.1 discovery.ts - New Resolution Pattern

The actual implementation introduced a more sophisticated discovery pattern:

```ts
export type WorkspaceResolution =
  | { status: 'found'; projectDir: ProjectDir; client: AnyWorkspaceClient }
  | { status: 'ambiguous'; configs: string[] }
  | { status: 'not_found' };

/**
 * Resolve and load a workspace from a directory.
 *
 * 1. Checks for config in the given directory
 * 2. If not found, checks subdirectories for ambiguity detection
 * 3. Loads and validates the client if found
 */
export async function resolveWorkspace(
  dir: string = process.cwd(),
): Promise<WorkspaceResolution> {
  const baseDir = resolve(dir);
  const configPath = join(baseDir, CONFIG_FILENAME);

  // Check for config in the specified directory
  if (await Bun.file(configPath).exists()) {
    const client = await loadClientFromPath(configPath);
    return { status: 'found', projectDir: baseDir as ProjectDir, client };
  }

  // No config in target dir - check subdirs for helpful error message
  const subdirConfigs = await findSubdirConfigs(baseDir);
  if (subdirConfigs.length > 0) {
    return { status: 'ambiguous', configs: subdirConfigs };
  }

  return { status: 'not_found' };
}
```

**Key improvements:**
- Discriminated union return type for type-safe error handling
- Automatic subdirectory scanning for helpful error messages
- Single function that combines discovery and loading
- Better error context with `tryAsync` integration

### 2.2 discovery.ts - Default Export Convention

The implementation introduced a new default export convention:

```ts
async function loadClientFromPath(configPath: string): Promise<AnyWorkspaceClient> {
  const module = await import(Bun.pathToFileURL(configPath).href);

  // New convention: export default createWorkspaceClient({...})
  if (module.default !== undefined) {
    const client = module.default;
    if (isWorkspaceClient(client)) {
      return client;
    }
    throw new Error(
      `Default export in ${CONFIG_FILENAME} is not a WorkspaceClient.\n` +
        `Expected: export default createWorkspaceClient({...})\n` +
        `Got: ${typeof client}`,
    );
  }

  // Fallback: support old convention of named exports (for migration)
  const exports = Object.entries(module);
  const clients = exports.filter(([, value]) => isWorkspaceClient(value));

  if (clients.length === 0) {
    throw new Error(
      `No WorkspaceClient found in ${CONFIG_FILENAME}.\n` +
        `Expected: export default createWorkspaceClient({...})`,
    );
  }

  if (clients.length > 1) {
    const names = clients.map(([name]) => name).join(', ');
    throw new Error(
      `Multiple WorkspaceClient exports found: ${names}\n` +
        `Epicenter supports one workspace per config. Use: export default createWorkspaceClient({...})`,
    );
  }

  return clients[0]![1] as AnyWorkspaceClient;
}
```

**Benefits:**
- Clearer intent with default export
- Backward compatible with named exports
- Better error messages listing export names
- Migration path for existing configs

### 2.3 bin.ts - Directory Flag Support

Added `-C` and `--dir` flag parsing before yargs processes subcommands:

```ts
export function parseDirectoryFlag(argv: string[]): DirectoryParseResult {
  let baseDir = process.cwd();
  const remainingArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    // Handle -C <dir> or --dir <dir>
    if (arg === '-C' || arg === '--dir') {
      const nextArg = argv[i + 1];
      if (!nextArg || nextArg.startsWith('-')) {
        return { ok: false, error: `${arg} requires a directory argument` };
      }
      baseDir = resolve(nextArg);
      i++;
      continue;
    }

    // Handle -C=<dir> or --dir=<dir>
    if (arg.startsWith('-C=')) {
      baseDir = resolve(arg.slice(3));
      continue;
    }
    if (arg.startsWith('--dir=')) {
      baseDir = resolve(arg.slice(6));
      continue;
    }

    remainingArgs.push(arg);
  }

  return { ok: true, baseDir, remainingArgs };
}
```

This allows running commands like:
```bash
epicenter -C blog posts list
epicenter --dir=shop products get abc123
```

### 2.4 Error Handling with tryAsync

Used `wellcrafted/result` for robust error handling:

```ts
const resolutionResult = await tryAsync(() => resolveWorkspace(baseDir));

if (!resolutionResult.ok) {
  console.error('Failed to load workspace:', resolutionResult.error.message);
  process.exit(1);
}

const resolution = resolutionResult.value;

if (resolution.status === 'not_found') {
  console.error('No epicenter.config.ts found in', baseDir);
  process.exit(1);
}

if (resolution.status === 'ambiguous') {
  console.error('No epicenter.config.ts found in current directory.\n');
  console.error('Found configs in subdirectories:');
  for (const config of resolution.configs) {
    console.error(`  - ${config}`);
  }
  console.error('\nUse -C <dir> to specify which project:');
  console.error('  epicenter -C <dir> <command>');
  process.exit(1);
}
```

### Original Plan: discovery.ts (for reference)

**Original simplified approach:**

```ts
export async function loadClient(
  projectDir: ProjectDir,
): Promise<AnyWorkspaceClient> {
  const configPath = join(projectDir, 'epicenter.config.ts');

  if (!(await fileExists(configPath))) {
    throw new Error(`No epicenter.config.ts found at ${configPath}`);
  }

  const module = await import(configPath);
  const clients = Object.values(module).filter(isWorkspaceClient);

  if (clients.length === 0) {
    throw new Error(
      `No WorkspaceClient exports found in epicenter.config.ts.\n` +
        `Export a client as: export const workspace = createWorkspaceClient({...})`,
    );
  }

  if (clients.length > 1) {
    throw new Error(
      `Found ${clients.length} WorkspaceClient exports. ` +
        `Epicenter supports one workspace per config file.\n` +
        `Use separate directories for multiple workspaces.`,
    );
  }

  return clients[0]!;
}
```

### 2.5 cli.ts - Actual Implementation

The actual implementation is clean and minimal:

```ts
export function createCLI(client: AnyWorkspaceClient, options?: CLIOptions) {
  let cli = yargs()
    .scriptName('epicenter')
    .usage('Usage: $0 <command> [options]')
    .help()
    .version()
    .strict()
    .command(
      'serve',
      'Start HTTP server with REST and WebSocket sync endpoints',
      (yargs) =>
        yargs.option('port', {
          type: 'number',
          description: 'Port to run the server on',
          default: DEFAULT_PORT,
        }),
      (argv) => {
        createServer(client as any, {
          port: argv.port,
          actions: options?.actions,
        }).start();
      },
    );

  // Add meta commands (tables)
  const metaCommands = buildMetaCommands(client);
  for (const cmd of metaCommands) {
    cli = cli.command(cmd);
  }

  // Add table commands for each table
  const tableCommands = buildTableCommands(client);
  for (const cmd of tableCommands) {
    cli = cli.command(cmd);
  }

  // Add KV commands
  const kvCommands = buildKvCommands(client);
  for (const cmd of kvCommands) {
    cli = cli.command(cmd);
  }

  // Add action commands if provided
  if (options?.actions) {
    const commands = buildActionCommands(options.actions);
    for (const cmd of commands) {
      cli = cli.command(cmd);
    }
  }

  return {
    async run(argv: string[]) {
      const cleanup = async () => {
        await client.destroy();
        process.exit(0);
      };
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);

      try {
        await cli.parse(argv);
      } finally {
        process.off('SIGINT', cleanup);
        process.off('SIGTERM', cleanup);
        await client.destroy();
      }
    },
  };
}
```

**Notable changes:**
- No array handling at all
- No mode configuration types
- No validation warnings (removed as dead code)
- Clean signal handling with cleanup
- Type cast for server compatibility (static vs dynamic types)

### 2.6 Command Builders - Simplified Signatures

All command builders were simplified to take a single client:

**table-commands.ts:**
```ts
export function buildTableCommands(client: AnyWorkspaceClient): CommandModule[] {
  const commands: CommandModule[] = [];
  const tableNames = Object.keys(client.tables);

  for (const tableName of tableNames) {
    const tableHelper = (client.tables as Record<string, unknown>)[tableName];
    commands.push(buildTableCommand(tableName, tableHelper));
  }

  return commands;
}
```

**kv-commands.ts:**
```ts
export function buildKvCommands(client: AnyWorkspaceClient): CommandModule[] {
  return [buildKvCommand(client)];
}
```

**meta-commands.ts:**
```ts
export function buildMetaCommands(client: AnyWorkspaceClient): CommandModule[] {
  return [
    {
      command: 'tables',
      describe: 'List all table names',
      builder: (yargs) => yargs.options(formatYargsOptions()),
      handler: (argv) => {
        const tableNames = Object.keys(client.tables);
        output(tableNames, { format: argv.format as any });
      },
    },
  ];
}

export const RESERVED_COMMANDS = [
  'serve',
  'tables',
  'kv',
  'help',
  'version',
  'init',
] as const; // 'workspaces' removed
```

### 2.4 kv-commands.ts

**Before:**

```ts
export function buildKvCommands(config: CommandConfig): CommandModule[] {
  const commands: CommandModule[] = [];

  for (const client of config.clients) {
    const commandPath = config.mode === 'single' ? 'kv' : `${client.id} kv`;
    commands.push(buildKvCommand(commandPath, client));
  }

  return commands;
}
```

**After:**

```ts
export function buildKvCommands(client: AnyWorkspaceClient): CommandModule[] {
  return [buildKvCommand(client)];
}

function buildKvCommand(client: AnyWorkspaceClient): CommandModule {
  return {
    command: 'kv <action>',
    // ... rest unchanged
  };
}
```

### 2.5 meta-commands.ts

**Before:**

```ts
export function buildMetaCommands(config: CommandConfig): CommandModule[] {
  const commands: CommandModule[] = [];

  // 'tables' command
  commands.push({
    command: 'tables',
    describe: 'List all table names',
    builder: (yargs) => yargs.options(formatYargsOptions()),
    handler: (argv) => {
      if (config.mode === 'single') {
        const tableNames = Object.keys(config.clients[0]!.tables);
        output(tableNames, { format: argv.format as any });
      } else {
        const result: Record<string, string[]> = {};
        for (const client of config.clients) {
          result[client.id] = Object.keys(client.tables);
        }
        output(result, { format: argv.format as any });
      }
    },
  });

  // 'workspaces' command
  commands.push({
    command: 'workspaces',
    describe: 'List all workspaces',
    // ...
  });

  return commands;
}

export const RESERVED_COMMANDS = [
  'serve',
  'tables',
  'workspaces',
  'kv',
  'help',
  'version',
  'init',
] as const;
```

**After:**

```ts
export function buildMetaCommands(client: AnyWorkspaceClient): CommandModule[] {
  return [
    {
      command: 'tables',
      describe: 'List all table names',
      builder: (yargs) => yargs.options(formatYargsOptions()),
      handler: (argv) => {
        const tableNames = Object.keys(client.tables);
        output(tableNames, { format: argv.format as any });
      },
    },
  ];
}

export const RESERVED_COMMANDS = [
  'serve',
  'tables',
  'kv',
  'help',
  'version',
  'init',
] as const;
```

### 2.6 index.ts

**Before:**

```ts
export { createCLI } from './cli';
export {
  createCommandConfig,
  findProjectDir,
  loadClients,
  type AnyWorkspaceClient,
  type CommandConfig,
  type MultiClientConfig,
  type SingleClientConfig,
} from './discovery';
export { buildTableCommands } from './commands/table-commands';
export { buildKvCommands } from './commands/kv-commands';
export {
  buildMetaCommands,
  RESERVED_COMMANDS,
  type ReservedCommand,
  isReservedCommand,
} from './commands/meta-commands';
```

**After:**

```ts
export { createCLI } from './cli';
export {
  findProjectDir,
  loadClient,
  type AnyWorkspaceClient,
} from './discovery';
export { buildTableCommands } from './commands/table-commands';
export { buildKvCommands } from './commands/kv-commands';
export {
  buildMetaCommands,
  RESERVED_COMMANDS,
  type ReservedCommand,
  isReservedCommand,
} from './commands/meta-commands';
```

---

## 3. Error Handling

### 3.1 Multiple Exports Error

When `loadClient()` finds multiple `WorkspaceClient` exports, throw a clear error:

```ts
if (clients.length > 1) {
  throw new Error(
    `Found ${clients.length} WorkspaceClient exports. ` +
      `Epicenter supports one workspace per config file.\n` +
      `Use separate directories for multiple workspaces.`,
  );
}
```

Example output:

```
Error: Found 3 WorkspaceClient exports. Epicenter supports one workspace per config file.
Use separate directories for multiple workspaces.
```

### 3.2 No Exports Error (unchanged)

```ts
if (clients.length === 0) {
  throw new Error(
    `No WorkspaceClient exports found in epicenter.config.ts.\n` +
      `Export a client as: export const workspace = createWorkspaceClient({...})`,
  );
}
```

---

## 4. Documentation Update (README.md)

### 4.1 Remove Multi-Workspace Section

**Delete:**

```markdown
## Multi-Workspace Mode

With multiple workspaces, prefix commands with the workspace name:

\`\`\`bash
epicenter blog table posts list
epicenter blog kv get theme
epicenter shop table products get abc123
\`\`\`
```

### 4.2 Remove Reserved Workspace Names

**Delete:**

```markdown
## Reserved Names

Table names have no restrictions.

Workspace names cannot be: `table`, `tables`, `kv`, `workspaces`, `serve`, `help`, `version`.
```

**Replace with:**

```markdown
## Reserved Names

Table names cannot match reserved commands: `serve`, `tables`, `kv`, `help`, `version`, `init`.

If a table name conflicts, the CLI will log a warning but still work.
```

### 4.3 Update Command Structure

**Before:**

```markdown
## Command Structure

\`\`\`bash
epicenter table <name> <action>   # table operations
epicenter kv <action>             # key-value operations
epicenter tables                  # list table names
epicenter workspaces              # list workspace names
epicenter serve                   # start HTTP/WebSocket server
\`\`\`
```

**After:**

```markdown
## Command Structure

\`\`\`bash
epicenter <table> <action>  # table operations (e.g., posts list)
epicenter kv <action>       # key-value operations
epicenter tables            # list table names
epicenter serve             # start HTTP/WebSocket server
\`\`\`
```

### 4.4 Updated README.md

```markdown
# Epicenter CLI

Manage workspace data and start the sync server.

## Command Structure

\`\`\`bash
epicenter <table> <action>  # table operations
epicenter kv <action>       # key-value operations
epicenter tables            # list table names
epicenter serve             # start HTTP/WebSocket server
\`\`\`

## Table Commands

\`\`\`bash
epicenter users list              # list all rows
epicenter users list --all        # include invalid rows
epicenter users get <id>          # get row by id
epicenter users set '<json>'      # create/replace row
epicenter users update <id> --name "New"  # partial update
epicenter users delete <id>       # delete row
epicenter users clear             # delete all rows
epicenter users count             # count rows
\`\`\`

## KV Commands

\`\`\`bash
epicenter kv get <key>            # get value
epicenter kv set <key> <value>    # set value
epicenter kv delete <key>         # delete key
\`\`\`

## Input Methods

\`\`\`bash
# Inline JSON
epicenter users set '{"id":"1","name":"Alice"}'

# From file
epicenter users set --file user.json
epicenter users set @user.json

# From stdin
cat user.json | epicenter users set

# Flag-based update
epicenter users update abc123 --name "Bob" --active true
\`\`\`

## Output Formats

\`\`\`bash
epicenter users list                  # pretty JSON (TTY)
epicenter users list | jq             # compact JSON (pipe)
epicenter users list --format json    # force JSON
epicenter users list --format jsonl   # JSON lines
\`\`\`

## Server

\`\`\`bash
epicenter serve              # default port 3913
epicenter serve --port 8080  # custom port
\`\`\`

Exposes REST API and WebSocket sync.

## Reserved Names

Table names cannot match reserved commands: `serve`, `tables`, `kv`, `help`, `version`, `init`.

If a table name conflicts, the CLI will log a warning but still work.

## Multiple Workspaces

For multiple workspaces, use separate directories with their own `epicenter.config.ts` files.
\`\`\`
```

---

## 5. Test Updates

### 5.1 Tests to Remove

Remove any test scenarios for multi-workspace mode:

- Tests with multiple `WorkspaceClient` exports
- Tests verifying `config.mode === 'multi'` behavior
- Tests for the `workspaces` command
- Tests for workspace name collision validation

### 5.2 New Test: Multiple Exports Error

```ts
import { test, expect } from 'bun:test';
import { loadClient } from './discovery';

test('loadClient throws on multiple exports', async () => {
  // Setup: create temp config with multiple exports
  const tempDir = await setupTempConfig(`
    export const blog = createWorkspaceClient({ id: 'blog', ... });
    export const shop = createWorkspaceClient({ id: 'shop', ... });
  `);

  await expect(loadClient(tempDir)).rejects.toThrow(
    /Found 2 WorkspaceClient exports/
  );
  await expect(loadClient(tempDir)).rejects.toThrow(
    /Epicenter supports one workspace per config file/
  );
});
```

### 5.3 Updated Single-Workspace Tests

Ensure existing tests work with simplified API:

```ts
test('createCLI works with single client', () => {
  const client = createMockClient();
  const cli = createCLI(client);

  // Should work without array wrapping
  expect(cli).toBeDefined();
});

test('buildTableCommands generates top-level commands', () => {
  const client = createMockClient({ tables: { posts: {}, users: {} } });
  const commands = buildTableCommands(client);

  expect(commands).toHaveLength(2);
  expect(commands[0].command).toBe('posts <action>');
  expect(commands[1].command).toBe('users <action>');
});
```

---

## 6. Implementation Status

### Code Changes ✅

- [x] Delete `MultiClientConfig` type from `discovery.ts`
- [x] Delete `SingleClientConfig` type from `discovery.ts`
- [x] Delete `CommandConfig` type from `discovery.ts`
- [x] Delete `createCommandConfig` function from `discovery.ts`
- [x] **IMPROVED**: Add `resolveWorkspace()` with discriminated union (better than planned `loadClient`)
- [x] **NEW**: Add default export convention with backward compatibility
- [x] **NEW**: Add subdirectory ambiguity detection
- [x] Update `createCLI` signature to take single client
- [x] Remove `clientArray` normalization in `cli.ts`
- [x] Remove client array loops in `cli.ts`
- [x] Remove `validateNames` function (was dead code)
- [x] Update `buildTableCommands` to take single client
- [x] Remove conditional command path in `buildTableCommands`
- [x] Update `buildKvCommands` to take single client
- [x] Remove conditional command path in `buildKvCommands`
- [x] Update `buildMetaCommands` to take single client
- [x] Remove `workspaces` command from `buildMetaCommands`
- [x] Remove mode conditional in `tables` handler
- [x] Remove `workspaces` from `RESERVED_COMMANDS`
- [x] Update exports in `index.ts`
- [x] **NEW**: Add `-C`/`--dir` flag parsing in `bin.ts`
- [x] **NEW**: Integrate `tryAsync` error handling throughout
- [x] **NEW**: Improve path handling for cross-platform compatibility

### Documentation ✅

- [x] Remove multi-workspace section from README
- [x] Update command examples to show direct table names
- [x] Update reserved names section
- [x] Add "Working Directory" section explaining `-C` flag
- [x] Add helpful error message examples
- [x] Add "Multiple Workspaces" section

### Additional Improvements

- [x] Used `tryAsync` from wellcrafted for robust error handling
- [x] Added `Bun.pathToFileURL()` for proper module loading
- [x] Improved error messages with context
- [x] Added helpful suggestions in error output
- [x] Cross-platform path normalization
- [x] Support for both `-C dir` and `-C=dir` syntax

---

## 7. Migration Notes

### For Users

If you have a config with multiple workspaces:

**Before:**
```ts
// epicenter.config.ts
export const blog = createWorkspaceClient({ id: 'blog', ... });
export const shop = createWorkspaceClient({ id: 'shop', ... });
```

**After:**
```
my-project/
├── blog/
│   └── epicenter.config.ts  // export const blog = ...
└── shop/
    └── epicenter.config.ts  // export const shop = ...
```

Run CLI from the appropriate directory:
```bash
cd blog && epicenter posts list
cd shop && epicenter products list
```

### Breaking Changes

1. Multiple `WorkspaceClient` exports now throw an error
2. `workspaces` command removed
3. `loadClients()` renamed to `loadClient()`
4. `createCLI()` no longer accepts arrays
5. `CommandConfig`, `SingleClientConfig`, `MultiClientConfig` types removed
