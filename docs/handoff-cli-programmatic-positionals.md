# CLI Programmatic Positionals Design

**Date**: 2025-10-14
**Status**: Design Proposal
**Goal**: Add type safety, help documentation, and tab completion to Epicenter CLI

## Current Implementation

### How It Works Now

The CLI uses a wildcard pattern that accepts any workspace and action names:

```typescript
cli.command(
  '$0 <workspace> <action>',
  'Execute a workspace action',
  (yargs) => {
    return yargs
      .positional('workspace', { type: 'string', describe: 'The workspace name' })
      .positional('action', { type: 'string', describe: 'The action to execute' })
      .strictOptions(false);
  },
  async (argv) => {
    // Runtime validation and execution
    const workspaceName = argv.workspace as string;
    const actionName = argv.action as string;

    // Find workspace in config
    const workspace = config.workspaces.find(ws => ws.name === workspaceName);
    if (!workspace) {
      console.error(`Error: Workspace "${workspaceName}" not found`);
      process.exit(1);
    }

    // Initialize entire client (expensive)
    const client = await createEpicenterClient(config);

    // Find and execute action
    const action = client[workspaceName][actionName];
    if (!action) {
      console.error(`Error: Action "${actionName}" not found`);
      process.exit(1);
    }

    const result = await action(argv);
    // Handle result...
  }
);

// Disable strict mode to allow any command
cli.strictCommands(false);
cli.strictOptions(false);
```

### Why This Approach Was Used

1. **Simplicity**: Easy to implement, works immediately
2. **Flexibility**: Handles any workspace/action combination without hardcoding
3. **Minimal code**: Single command handler, no complex generation logic

### What We're Losing

1. **No type safety**: `bun cli bloggg createPostttt` only fails at runtime
2. **Poor discoverability**: `bun cli --help` doesn't show available workspaces
3. **No workspace help**: `bun cli blog --help` doesn't show blog's actions
4. **No action help**: `bun cli blog createPost --help` doesn't show parameters
5. **No tab completion**: Shell completion can't suggest valid workspace/action names
6. **Late validation**: Errors only caught after expensive client initialization

## The Problem

Consider this user experience:

```bash
# User wants to create a blog post but doesn't know the command
$ bun cli --help
Usage: epicenter <workspace> <action> [options]

Commands:
  epicenter <workspace> <action>  Execute a workspace action

# Not helpful! What workspaces exist? What actions?

# User tries to guess
$ bun cli blog create
Error: Action "create" not found in workspace "blog"
Available actions: getPublishedPosts, getPost, getPostComments, createPost, publishPost, addComment, incrementViews

# Now they know, but this required:
# 1. Initializing YJS doc
# 2. Creating Db instance
# 3. Initializing all indexes (SQLite, markdown, etc.)
# 4. Only THEN checking if action exists
# All this work just to show an error message!

# Finally works, but how do I pass parameters?
$ bun cli blog createPost --help
# Shows generic help, not action-specific parameters

# User has to read the code or docs to know:
$ bun cli blog createPost --title "Hello World" --category tech
```

This is frustrating. The CLI should be self-documenting.

## Desired Experience

What we want:

```bash
# Discover workspaces
$ bun cli --help
Usage: epicenter <workspace> <action> [options]

Workspaces:
  blog  Blog workspace with posts and comments

# Discover actions
$ bun cli blog --help
Usage: epicenter blog <action> [options]

Actions:
  getPublishedPosts        Get all published posts
  getPost                  Get post by ID
  createPost               Create a new post
  publishPost              Publish a post
  addComment               Add a comment to a post
  # ... etc

# Discover parameters
$ bun cli blog createPost --help
Usage: epicenter blog createPost [options]

Create a new blog post

Options:
  --title <string>         Post title (required)
  --content <string>       Post content (optional)
  --category <string>      Category: tech, personal, tutorial (required)
  --help                   Show help

# Tab completion works
$ bun cli bl<TAB>
blog

$ bun cli blog cre<TAB>
createPost

# Validation before initialization
$ bun cli blog create
Error: Unknown action "create" in workspace "blog"
Did you mean "createPost"?

Available actions: getPublishedPosts, getPost, createPost, publishPost, ...
# ^ This error is instant, no initialization needed
```

## Proposed Design

### Overview

Generate yargs command hierarchy programmatically from workspace config:

```
epicenter (root)
├── blog (workspace command)
│   ├── getPublishedPosts (action command)
│   ├── getPost (action command)
│   │   └── --id <string> (from Zod schema)
│   ├── createPost (action command)
│   │   ├── --title <string> (from Zod schema)
│   │   ├── --content <string> (from Zod schema)
│   │   └── --category <string> (from Zod schema)
│   └── ...
└── reddit (workspace command)
    └── ...
```

Each level is a real yargs command with proper help text and validation.

### The Challenge: Action Introspection

The workspace config structure makes introspection difficult:

```typescript
const workspace = defineWorkspace({
  actions: ({ db, indexes }) => ({
    createPost: defineMutation({
      input: z.object({ title: z.string() }),
      handler: async ({ title }) => {
        // ...
      }
    })
  })
});
```

The `actions` field is a **factory function**. To get the action map, we need to:

1. Create a YJS document
2. Initialize a Db instance
3. Initialize all indexes (SQLite, markdown, etc.)
4. Call the actions factory with context
5. Only then can we introspect the returned action map

This is expensive (hundreds of milliseconds) and not suitable for generating help text that should be instant.

### Solution: Metadata Extraction with Caching

**Key Insight**: We only need metadata (names + schemas), not actual working instances.

```typescript
type ActionMetadata = {
  name: string;
  type: 'query' | 'mutation';
  inputSchema: any; // The Zod schema
  description?: string;
};

type WorkspaceMetadata = {
  name: string;
  actions: ActionMetadata[];
};

async function extractWorkspaceMetadata(
  config: EpicenterConfig
): Promise<WorkspaceMetadata[]> {
  // Check cache first
  const cacheKey = hashConfig(config);
  const cached = await loadFromCache(cacheKey);
  if (cached) return cached; // Fast path: ~1ms

  // Cache miss: extract metadata (slow path: ~500ms)
  const metadata: WorkspaceMetadata[] = [];

  for (const workspace of config.workspaces) {
    // Initialize minimal context (skip expensive index creation)
    const ydoc = new Y.Doc();
    const db = createDb(workspace.schema, ydoc);
    const indexes = {}; // Empty, not needed for metadata

    // Call actions factory to get action map
    const actionMap = workspace.actions({ db, indexes, workspaces: {} });

    // Extract metadata from each action
    const actions: ActionMetadata[] = [];
    for (const [name, action] of Object.entries(actionMap)) {
      actions.push({
        name,
        type: action.type, // 'query' or 'mutation'
        inputSchema: action.input, // The Zod schema
        description: action.description,
      });
    }

    metadata.push({
      name: workspace.name,
      actions,
    });
  }

  // Save to cache for next time
  await saveToCache(cacheKey, metadata);

  return metadata;
}
```

**Caching Strategy**:
- Store metadata in `.epicenter/cli-cache.json`
- Cache key is hash of config file content
- Cache is invalidated when config changes
- First run is slow (~500ms), subsequent runs are fast (~1ms)

### CLI Generation

Use metadata to generate command hierarchy:

```typescript
export function createCLI(
  config: EpicenterConfig,
  options: CreateCLIOptions = {}
): ReturnType<typeof yargs> {
  const {
    schemaConverters = [createZodConverter(), createArktypeConverter()],
    argv = process.argv,
  } = options;

  const cli = yargs(hideBin(argv))
    .scriptName('epicenter')
    .usage('Usage: $0 <workspace> <action> [options]')
    .help()
    .version()
    .demandCommand(1, 'You must specify a workspace')
    .strict(); // Enable strict mode!

  // Extract metadata (fast if cached)
  const metadata = await extractWorkspaceMetadata(config);

  // Generate workspace commands
  for (const workspace of metadata) {
    cli.command(
      workspace.name,
      `Execute ${workspace.name} actions`,
      (yargs) => {
        yargs
          .usage(`Usage: $0 ${workspace.name} <action> [options]`)
          .demandCommand(1, 'You must specify an action')
          .strict();

        // Generate action commands
        for (const action of workspace.actions) {
          yargs.command(
            action.name,
            action.description || `Execute ${action.name}`,
            (yargs) => {
              // Convert Zod schema to yargs options
              if (action.inputSchema) {
                applySchemaConverters(
                  action.inputSchema,
                  yargs,
                  schemaConverters
                );
              }
              return yargs.strict();
            },
            async (argv) => {
              // Execute the action
              await executeAction(
                config,
                workspace.name,
                action.name,
                argv
              );
            }
          );
        }

        return yargs;
      }
    );
  }

  return cli;
}
```

### Action Execution

Extract execution logic into separate function:

```typescript
async function executeAction(
  config: EpicenterConfig,
  workspaceName: string,
  actionName: string,
  argv: Record<string, any>
): Promise<void> {
  console.log(`Executing ${workspaceName}.${actionName}...`);

  // Initialize full client (this is the expensive part)
  const client = await createEpicenterClient(config);

  try {
    // Get workspace
    const workspace = (client as any)[workspaceName];
    if (!workspace) {
      throw new Error(`Workspace "${workspaceName}" not found`);
    }

    // Get action
    const action = workspace[actionName];
    if (typeof action !== 'function') {
      throw new Error(`Action "${actionName}" not found`);
    }

    // Extract action arguments (filter out yargs metadata)
    const actionArgs: Record<string, any> = {};
    for (const [key, value] of Object.entries(argv)) {
      if (
        key !== '_' &&
        key !== '$0' &&
        !key.startsWith('$')
      ) {
        actionArgs[key] = value;
      }
    }

    // Execute action
    const result = await action(actionArgs);

    // Handle Result type
    if (result && typeof result === 'object' && 'data' in result && 'error' in result) {
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      } else {
        const data = result.data instanceof Promise ? await result.data : result.data;
        console.log('Success:', data);
      }
    } else {
      console.log('Result:', result);
    }

    // HACK: Give observers time to process YJS changes
    await new Promise(resolve => setTimeout(resolve, 100));

  } finally {
    // Cleanup
    await client.destroy();
    process.exit(0);
  }
}
```

## Implementation Plan

### Phase 1: Metadata Extraction

1. **Create `extractWorkspaceMetadata` function**
   - Location: `packages/epicenter/src/cli/metadata.ts`
   - Input: `EpicenterConfig`
   - Output: `WorkspaceMetadata[]`
   - Initialize minimal context (YJS doc + Db, skip indexes)
   - Call actions factory to get action map
   - Extract name, type, inputSchema, description from each action

2. **Add caching utilities**
   - Location: `packages/epicenter/src/cli/cache.ts`
   - `hashConfig(config: EpicenterConfig): string` - Hash config for cache key
   - `loadFromCache(key: string): Promise<WorkspaceMetadata[] | null>`
   - `saveToCache(key: string, metadata: WorkspaceMetadata[]): Promise<void>`
   - Cache location: `.epicenter/cli-cache.json`

3. **Add types**
   - Location: `packages/epicenter/src/cli/types.ts`
   ```typescript
   export type ActionMetadata = {
     name: string;
     type: 'query' | 'mutation';
     inputSchema: any;
     description?: string;
   };

   export type WorkspaceMetadata = {
     name: string;
     description?: string;
     actions: ActionMetadata[];
   };
   ```

### Phase 2: CLI Generation

1. **Modify `createCLI` function**
   - Location: `packages/epicenter/src/cli/create-cli.ts`
   - Remove wildcard pattern `$0 <workspace> <action>`
   - Enable strict mode: `cli.strict()`
   - Call `extractWorkspaceMetadata(config)`
   - Generate workspace commands from metadata
   - Generate action subcommands for each workspace
   - Use `applySchemaConverters` to convert input schemas to yargs options

2. **Extract execution logic**
   - Location: `packages/epicenter/src/cli/execute.ts`
   - Move current execution code to `executeAction` function
   - Clean up argument filtering
   - Improve error handling
   - Add better result formatting

### Phase 3: Enhanced Action Definitions

1. **Add description field to actions**
   - Modify `defineQuery` and `defineMutation` types
   - Accept optional `description` field
   ```typescript
   defineQuery({
     description: 'Get all published posts',
     handler: async () => { /* ... */ }
   })
   ```

2. **Add examples field (future)**
   - Optional: Add `examples` array for command examples
   ```typescript
   defineQuery({
     description: 'Get post by ID',
     examples: [
       'epicenter blog getPost --id "post123"',
     ],
     input: z.object({ id: z.string() }),
     handler: async ({ id }) => { /* ... */ }
   })
   ```

### Phase 4: Polish

1. **Add spinner for first run**
   - Show "Initializing CLI..." when extracting metadata
   - Use `ora` or similar spinner library

2. **Better error messages**
   - "Did you mean X?" suggestions for typos
   - Use string similarity (Levenshtein distance)

3. **Add workspace descriptions**
   - Optional `description` field in workspace config
   - Show in help text

4. **Group actions in help**
   - Separate queries from mutations in help output
   - Maybe use yargs groups: `yargs.group(['getPost', 'getPublishedPosts'], 'Queries:')`

## Edge Cases

### 1. Many Actions

Some workspaces might have 50+ actions. Help text gets long.

**Solution**:
- Group by type (queries vs mutations)
- Use yargs groups for better organization
- Consider pagination or filtering in help

### 2. Complex Input Schemas

Not all Zod schemas map cleanly to CLI flags:

```typescript
// Simple: ✅
input: z.object({ id: z.string() })
// --> --id <string>

// Optional: ✅
input: z.object({ limit: z.number().optional() })
// --> --limit <number> (optional)

// Array: ⚠️
input: z.object({ tags: z.array(z.string()) })
// --> --tags <string> (comma-separated? multiple flags?)

// Nested object: ❌
input: z.object({
  user: z.object({
    name: z.string(),
    email: z.string()
  })
})
// --> How to represent in CLI?

// Union: ❌
input: z.union([z.object({ id: z.string() }), z.object({ slug: z.string() })])
// --> Can't represent as CLI flags
```

**Solution**:
- Support simple types (string, number, boolean, arrays)
- For complex types, accept JSON string: `--user '{"name":"John","email":"john@example.com"}'`
- Document limitations
- Schema converters can handle most cases

### 3. Required vs Optional Parameters

Zod's optional/required must map to yargs' `demandOption`:

```typescript
// Required
input: z.object({ title: z.string() })
// --> .option('title', { type: 'string', demandOption: true })

// Optional
input: z.object({ content: z.string().optional() })
// --> .option('content', { type: 'string', demandOption: false })

// Default value
input: z.object({ views: z.number().default(0) })
// --> .option('views', { type: 'number', default: 0 })
```

Schema converters should handle this.

### 4. First-Run Performance

First run needs to:
- Initialize YJS docs for all workspaces
- Create Db instances
- Call all actions factories
- This might take 500ms-1s

**Solution**:
- Show spinner: "Initializing CLI..."
- Cache aggressively
- Consider pre-generating cache at build time
- Optimize: only initialize DB, skip index creation

### 5. Config Changes

When config changes, cache must be invalidated.

**Solution**:
- Hash config file content
- Include hash in cache key
- If hash changes, cache miss → regenerate
- Alternative: Watch config file mtime

### 6. Workspace Dependencies

If workspace A depends on workspace B:
- Should B's actions be accessible when running A's commands?
- Probably not; keep workspaces isolated at CLI level
- Dependencies are for action implementation, not CLI structure

### 7. Action Name Collisions

What if two workspaces have actions with the same name?

```typescript
blog.actions = { createPost: ... }
forum.actions = { createPost: ... }
```

**Solution**:
- Not a problem! Commands are namespaced by workspace:
  - `bun cli blog createPost`
  - `bun cli forum createPost`

### 8. Schema Converter Gaps

What if an action uses a schema type that converters don't support?

**Solution**:
- Converters should log warnings for unsupported types
- Fall back to string type with description
- Document which schema features are supported

## Type Safety Strategy

### Command Validation

With the new approach, yargs validates commands at parse time:

```bash
# Before (wildcard):
$ bun cli bloggg createPost
# No error until runtime, after expensive initialization

# After (programmatic):
$ bun cli bloggg createPost
error: Unknown workspace "bloggg"

Did you mean "blog"?

Available workspaces: blog, reddit

# Error is instant, no initialization needed
```

### Argument Validation

Yargs validates arguments based on generated options:

```bash
# Before:
$ bun cli blog createPost
# No error, missing required --title flag only caught by Zod in handler

# After:
$ bun cli blog createPost
error: Missing required argument: title

# Caught by yargs before handler is called
```

### Type Inference

TypeScript can infer valid workspace/action names from config:

```typescript
// Future enhancement: Type-safe CLI builder
const cli = createCLI(config);

// TypeScript knows valid commands
cli.command('blog', /* ... */); // ✅
cli.command('invalid', /* ... */); // ❌ Type error
```

This requires more advanced type-level programming and is out of scope for initial implementation.

## Help Generation Strategy

### Root Help

```bash
$ bun cli --help
Usage: epicenter <workspace> <action> [options]

Execute workspace actions with full type safety

Workspaces:
  blog    Blog workspace with posts and comments
  reddit  Reddit integration workspace

Options:
  --help     Show help
  --version  Show version number

Examples:
  epicenter blog createPost --title "Hello" --category tech
  epicenter reddit import --url "https://reddit.com/r/typescript"
```

### Workspace Help

```bash
$ bun cli blog --help
Usage: epicenter blog <action> [options]

Blog workspace with posts and comments

Queries:
  getPublishedPosts       Get all published posts
  getPost                 Get post by ID
  getPostComments         Get comments for a post

Mutations:
  createPost              Create a new blog post
  publishPost             Publish a post
  addComment              Add a comment to a post
  incrementViews          Increment post view count

Options:
  --help  Show help

Examples:
  epicenter blog createPost --title "Hello World" --category tech
  epicenter blog getPost --id "post123"
```

### Action Help

```bash
$ bun cli blog createPost --help
Usage: epicenter blog createPost [options]

Create a new blog post

Options:
  --title <string>       Post title (required)
  --content <string>     Post content (optional)
  --category <string>    Category: tech, personal, tutorial (required)
  --help                 Show help

Examples:
  epicenter blog createPost --title "Hello World" --category tech
  epicenter blog createPost --title "My Journey" --content "..." --category personal
```

## Code Examples

### Before (Current)

```typescript
// create-cli.ts
export function createCLI(config: EpicenterConfig): ReturnType<typeof yargs> {
  const cli = yargs(hideBin(process.argv))
    .scriptName('epicenter')
    .strictCommands(false) // Allow any command
    .strictOptions(false); // Allow any options

  cli.command(
    '$0 <workspace> <action>', // Wildcard pattern
    'Execute a workspace action',
    (yargs) => {
      return yargs
        .positional('workspace', { type: 'string', describe: 'The workspace name' })
        .positional('action', { type: 'string', describe: 'The action to execute' })
        .strictOptions(false);
    },
    async (argv) => {
      // Runtime validation and execution
      const workspaceName = argv.workspace as string;
      const actionName = argv.action as string;

      // Find workspace
      const workspace = config.workspaces.find(ws => ws.name === workspaceName);
      if (!workspace) {
        console.error(`Error: Workspace "${workspaceName}" not found`);
        process.exit(1);
      }

      // Initialize entire client (expensive!)
      const client = await createEpicenterClient(config);

      // Find action
      const action = client[workspaceName][actionName];
      if (!action) {
        console.error(`Error: Action "${actionName}" not found`);
        process.exit(1);
      }

      // Execute
      await action(argv);
    }
  );

  return cli;
}
```

Usage:
```bash
$ bun cli --help
# Generic help, doesn't show workspaces

$ bun cli blog --help
# Still generic help

$ bun cli blog createPost --help
# Still generic help

$ bun cli invalid invalid
# Error only after initialization
```

### After (Proposed)

```typescript
// create-cli.ts
export function createCLI(config: EpicenterConfig): ReturnType<typeof yargs> {
  const cli = yargs(hideBin(process.argv))
    .scriptName('epicenter')
    .usage('Usage: $0 <workspace> <action> [options]')
    .help()
    .version()
    .demandCommand(1, 'You must specify a workspace')
    .strict(); // Enable strict mode!

  // Extract metadata (fast if cached)
  const metadata = await extractWorkspaceMetadata(config);

  // Generate workspace commands
  for (const workspace of metadata) {
    cli.command(
      workspace.name,
      workspace.description || `Execute ${workspace.name} actions`,
      (yargs) => {
        yargs
          .usage(`Usage: $0 ${workspace.name} <action> [options]`)
          .demandCommand(1, 'You must specify an action')
          .strict();

        // Generate action commands
        for (const action of workspace.actions) {
          yargs.command(
            action.name,
            action.description || `Execute ${action.name}`,
            (yargs) => {
              // Convert Zod schema to yargs options
              if (action.inputSchema) {
                applySchemaConverters(
                  action.inputSchema,
                  yargs,
                  schemaConverters
                );
              }
              return yargs.strict();
            },
            async (argv) => {
              // Execute action
              await executeAction(
                config,
                workspace.name,
                action.name,
                argv
              );
            }
          );
        }

        return yargs;
      }
    );
  }

  return cli;
}
```

Usage:
```bash
$ bun cli --help
# Shows all workspaces!

$ bun cli blog --help
# Shows all blog actions!

$ bun cli blog createPost --help
# Shows createPost parameters!

$ bun cli invalid invalid
# Error before initialization!
```

## Breaking Changes

**None!** This is purely an enhancement to the CLI. The workspace config API stays the same.

Existing configs work without modification:
```typescript
// This still works exactly as before
const workspace = defineWorkspace({
  actions: ({ db, indexes }) => ({
    createPost: defineMutation({
      input: z.object({ title: z.string() }),
      handler: async ({ title }) => { /* ... */ }
    })
  })
});
```

## Optional Enhancements

These are not required for the initial implementation but would improve the experience:

### 1. Add Description to Actions

```typescript
// Current
createPost: defineMutation({
  input: z.object({ title: z.string() }),
  handler: async ({ title }) => { /* ... */ }
})

// Enhanced
createPost: defineMutation({
  description: 'Create a new blog post',
  input: z.object({ title: z.string() }),
  handler: async ({ title }) => { /* ... */ }
})
```

### 2. Add Description to Workspaces

```typescript
// Current
const workspace = defineWorkspace({
  name: 'blog',
  schema: { /* ... */ },
  actions: { /* ... */ }
});

// Enhanced
const workspace = defineWorkspace({
  name: 'blog',
  description: 'Blog workspace with posts and comments',
  schema: { /* ... */ },
  actions: { /* ... */ }
});
```

### 3. Add Examples to Actions

```typescript
createPost: defineMutation({
  description: 'Create a new blog post',
  examples: [
    'epicenter blog createPost --title "Hello World" --category tech',
    'epicenter blog createPost --title "My Story" --content "..." --category personal',
  ],
  input: z.object({ title: z.string() }),
  handler: async ({ title }) => { /* ... */ }
})
```

### 4. Pre-Generate Cache

Build step that generates cache before distribution:

```json
// package.json
{
  "scripts": {
    "build": "bun build && bun cli:cache"
  }
}
```

This eliminates first-run slowness for users.

### 5. Type-Safe Command Builder

Advanced: Make `createCLI` infer valid commands from config:

```typescript
const cli = createCLI(config);

// TypeScript knows valid commands
cli.execute('blog', 'createPost', { title: 'Hello' }); // ✅
cli.execute('invalid', 'invalid', {}); // ❌ Type error
```

This requires significant type-level programming and is probably not worth the complexity.

## Testing Strategy

### Unit Tests

1. **Metadata extraction**
   - Test extracting metadata from simple workspace
   - Test extracting metadata from workspace with many actions
   - Test extracting metadata from workspace with complex schemas

2. **Caching**
   - Test cache hit (fast path)
   - Test cache miss (slow path)
   - Test cache invalidation on config change

3. **CLI generation**
   - Test generating workspace commands
   - Test generating action commands
   - Test schema conversion to yargs options

### Integration Tests

1. **Help text**
   - Test `bun cli --help` shows workspaces
   - Test `bun cli blog --help` shows actions
   - Test `bun cli blog createPost --help` shows parameters

2. **Validation**
   - Test invalid workspace name caught before initialization
   - Test invalid action name caught before initialization
   - Test missing required parameter caught by yargs

3. **Execution**
   - Test successful action execution
   - Test error handling

### Performance Tests

1. **First run** (cache miss)
   - Should complete in <1 second for typical config

2. **Subsequent runs** (cache hit)
   - Should complete in <100ms

3. **Help commands**
   - Should be instant (<50ms)

## Success Criteria

The implementation is successful when:

1. ✅ `bun cli --help` shows all available workspaces
2. ✅ `bun cli blog --help` shows all actions for blog workspace
3. ✅ `bun cli blog createPost --help` shows parameters for createPost action
4. ✅ Invalid workspace names are caught before client initialization
5. ✅ Invalid action names are caught before client initialization
6. ✅ Tab completion works for workspace and action names
7. ✅ Help commands complete in <100ms (after first run)
8. ✅ No breaking changes to workspace config API
9. ✅ Error messages include "Did you mean?" suggestions
10. ✅ All existing tests pass

## Next Steps

1. **Implement Phase 1**: Metadata extraction and caching
2. **Implement Phase 2**: CLI generation
3. **Test thoroughly**: Unit, integration, and performance tests
4. **Gather feedback**: Use in real projects, iterate on UX
5. **Consider Phase 3**: Enhanced action definitions (descriptions, examples)
6. **Document**: Update README with new CLI capabilities

## Open Questions

1. **Should we pre-generate cache?** Would eliminate first-run slowness but adds build complexity.

2. **How to handle very complex schemas?** Some Zod schemas don't map cleanly to CLI flags. Accept JSON strings?

3. **Should dependencies affect CLI structure?** Currently planning to keep workspaces isolated at CLI level.

4. **How much caching?** Just metadata, or also the initialized client? (Probably just metadata)

5. **Should we use a different CLI library?** yargs works but is showing its age. Consider `clipanion` or `commander`?

## Conclusion

This design adds type safety, discoverability, and better UX to the Epicenter CLI without breaking changes. The key insight is using metadata extraction with aggressive caching to make command generation fast while keeping the workspace config API simple and unchanged.

The implementation is straightforward:
1. Extract metadata (workspace names, action names, input schemas)
2. Cache metadata for performance
3. Generate yargs command hierarchy from metadata
4. Use schema converters to turn Zod schemas into CLI options

This gives users a self-documenting CLI with proper help text at every level, tab completion support, and fast validation that catches errors before expensive initialization.
