# Epicenter CLI

Turn your Epicenter workspaces into command-line tools automatically.

## What This Does

The CLI system generates command-line interfaces from your Epicenter configuration. Define your workspaces with their actions, and instantly get a typed, validated CLI that you can run from the terminal.

```bash
epicenter <workspace> <action> [flags]
```

That's it. No manual CLI setup, no repetitive argument parsing. Your workspace actions become commands, and your Standard Schema definitions become CLI flags.

## How It Works

### 1. Define Your Workspace Actions

Write your workspace actions like you normally would:

```typescript
import { type } from 'arktype';

const reddit = defineWorkspace({
  name: 'reddit',
  exports: ({ db }) => ({
    import: defineMutation({
      input: type({
        'url': 'string',
        'count': 'number = 10'
      }).describe({
        url: 'Reddit URL to import',
        count: 'Number of posts'
      }),
      handler: async ({ url, count }) => {
        // Your import logic here
        return Ok(result);
      }
    })
  })
});
```

### 2. Create an Epicenter Config

In your project root, create `epicenter.config.ts`:

```typescript
import { defineEpicenter } from '@epicenter/hq';
import { reddit, blog } from './workspaces';

export default defineEpicenter({
  id: 'my-app',
  workspaces: [reddit, blog],
});
```

### 3. Run Commands

The CLI automatically discovers your config and exposes your actions:

```bash
epicenter reddit import --url "https://reddit.com/r/typescript" --count 25
epicenter blog publish --title "My Post" --tags tech typescript coding
```

## Schema-Driven Flags

Your action's input schema automatically becomes CLI flags:

- `'string'` → `--flag <value>`
- `'number'` → `--flag <number>`
- `'boolean'` → `--flag` (presence = true)
- `'string[]'` → `--flag item1 item2 item3` (space-separated)
- `'"a" | "b"'` → `--flag <choice>` (with validation)
- `'string?'` → flag is optional
- `'number = 10'` → flag has a default value
- `.describe({})` → shows descriptions in `--help`

**Array values**: Use spaces to separate multiple values:
```bash
epicenter workspace action --tags tech productivity typescript
```

## Standard Schema Conversion

The CLI uses Standard Schema for validation. The `standardSchemaToYargs` function converts Standard Schema definitions to yargs CLI options by introspecting the schema structure:

```typescript
// Your ArkType schema
const schema = type({
  url: 'string',
  'count?': 'number = 10'
}).describe({
  url: 'Reddit URL',
  count: 'Number of posts'
});

// Automatically converted to yargs options:
// --url <string> (required) - Reddit URL
// --count <number> (optional, default: 10)
```

The converter works by examining the Standard Schema's `~standard` property and converting it to JSON Schema, then mapping that to appropriate yargs option types. This works with any Standard Schema-compliant library (ArkType, Valibot, Zod, etc.).

## Under the Hood

When you run a command:

1. **Config Loading**: Finds `epicenter.config.ts` in your project
2. **Schema Introspection**: Examines action schemas to generate flags
3. **Client Creation**: Initializes the epicenter client with all workspaces
4. **Action Execution**: Calls the requested action with parsed arguments
5. **Result Handling**: Displays success data or error messages

The CLI handles Result types from `wellcrafted`, showing errors clearly and exiting with appropriate status codes.

## Error Handling

The CLI provides helpful error messages:

- **Config not found**: Lists expected file names
- **Workspace not found**: Shows available workspaces
- **Action not found**: Lists available actions for that workspace
- **Invalid arguments**: Shows validation errors from your schema
- **Action errors**: Displays error details from Result types

## Testing Your CLI

Test your CLI commands programmatically:

```typescript
import { createCLI } from '@epicenter/hq/cli';

// createCLI parses and executes the command internally
await createCLI({
  config: epicenter,
  argv: ['reddit', 'import', '--url', 'https://...', '--count', '5']
});
```

## Implementation Architecture

### Two-Phase Design

The CLI uses a two-phase approach to balance speed and functionality:

**Phase 1: CLI Setup (Fast - ~10-20ms)**
- Extracts metadata using mock context (no YJS initialization)
- Builds yargs command hierarchy (workspace → action)
- Converts Standard Schema definitions to CLI flags
- Enables fast `--help` commands

**Phase 2: Command Execution (On-Demand)**
- Creates real workspace client with YJS docs
- Initializes indexes and dependencies
- Executes action handler
- Cleans up with `await using` disposal

### Mock Context Pattern

To avoid expensive YJS initialization during help/introspection, the CLI uses mock implementations:

```typescript
const mockContext = createMockContext(workspace.schema);
const actions = workspace.actions(mockContext);

// Extract metadata without executing handlers
for (const [name, action] of Object.entries(actions)) {
  console.log(name, action.type, action.input);
}
```

This keeps help commands instant while deferring real initialization until command execution.

### File Organization

- `bin.ts`: Entry point for CLI executable
- `cli.ts`: Core CLI creation logic
- `metadata.ts`: Fast metadata extraction using mocks
- `standardschema-to-yargs.ts`: Schema to CLI flag conversion
- `load-config.ts`: Config file discovery and loading
- `mock-context.ts`: Mock db/indexes/workspaces for introspection
- `index.ts`: Public API exports for programmatic use

### Resource Management

The CLI uses explicit resource management (`await using`) to ensure proper cleanup:

```typescript
await using client = await createWorkspaceClient(workspaceConfig);
// Client automatically disposed after execution
```

This prevents resource leaks when running CLI commands.

## Philosophy

Command-line interfaces should be generated, not hand-written. Your workspace actions already define what arguments they accept and what they do. The CLI just exposes that over the terminal.

No boilerplate. No duplication. Just your actions, accessible from the command line.
