# Simplify MCP Implementation with TypeBox

## Analysis

### Current State

The current MCP implementation manually:
1. Defines TypeScript types for MCP structures (MCPTool, MCPToolsListResponse, etc.)
2. Extracts handler names from client using `Object.keys()` filtering
3. Creates simple action registry with `{ handler: Function }` objects
4. Manually builds MCP tool definitions without using existing TypeBox schemas
5. Converts action calls to MCP format manually

### Key Insight

Since all actions use TypeBox schemas via `defineQuery` and `defineMutation`, we can:
1. **Auto-convert TypeBox to JSON Schema** using `@sinclair/typebox`'s built-in `Type.Strict()` or compile to JSON Schema
2. **Eliminate manual type definitions** since TypeBox already has schema metadata
3. **Auto-generate MCP tool names and descriptions** from action metadata
4. **Simplify tool registration** by directly iterating over actions

### Comparison with Official SDK

The official MCP SDK uses Zod and provides:
- `zodToJsonSchema()` to convert Zod schemas to JSON Schema
- Automatic validation of tool inputs
- Type-safe callbacks with inferred parameter types
- Automatic tool list and call handlers

We can mirror this but with TypeBox instead of Zod.

## Design: Simplified API

### Core Principles

1. **Use TypeBox schemas directly** from actions
2. **Auto-generate tool definitions** from action metadata
3. **Remove all manual type definitions** for MCP structures
4. **Leverage action Result types** for consistent error handling
5. **Keep it simple** with minimal abstraction

### Proposed API

```typescript
import { createWorkspaceServer } from '@epicenter/server';
import { workspace } from './workspace';

// Simple, one-line server creation
const app = await createWorkspaceServer(workspace);

// Routes are automatically created:
// - GET/POST /{actionName} for each action
// - POST /mcp/tools/list
// - POST /mcp/tools/call

// Actions automatically become MCP tools with:
// - name: actionName
// - description: action.description (from defineQuery/defineMutation)
// - inputSchema: JSON Schema converted from action.input (TypeBox)
```

### Key Changes

#### 1. Remove Manual Types

**Before:**
```typescript
export type MCPTool = {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, any>; required?: string[] };
};
```

**After:**
Use TypeBox's built-in JSON Schema generation.

#### 2. Auto-Generate Tool Definitions

**Before:**
```typescript
export function createMCPTools(exports: Record<string, { handler: Function }>): MCPTool[] {
  return Object.entries(actions).map(([name]) => ({
    name,
    inputSchema: { type: 'object' },
  }));
}
```

**After:**
```typescript
import { Type } from 'typebox';

function createMCPTools(exports: WorkspaceActionMap): Tool[] {
  return Object.entries(actions).map(([name, action]) => ({
    name,
    description: action.description,
    inputSchema: action.input
      ? typeboxToJsonSchema(action.input)
      : { type: 'object', properties: {} },
  }));
}
```

#### 3. Type-Safe Tool Execution

**Before:**
```typescript
const result = await actionEntry.handler(request.arguments || {});
```

**After:**
```typescript
// Validate input against TypeBox schema
if (action.input) {
  const validation = Value.Check(action.input, request.arguments);
  if (!validation) {
    return errorResponse('Invalid input');
  }
}

// Call with validated input
const result = await action(request.arguments);
```

## Implementation Plan

- [x] Analyze current implementation
- [x] Install @modelcontextprotocol/sdk
- [x] Refactor workspace.ts to use official SDK
- [x] Remove custom mcp.ts entirely
- [x] Create MCP server example
- [ ] Test with content-hub example

## Final Implementation

### Changes Made

1. **Installed Official SDK**
   - `@modelcontextprotocol/sdk@1.20.1`
   - Uses official types and transports

2. **Simplified workspace.ts**
   - `createWorkspaceServer()` - HTTP REST API (unchanged)
   - `createWorkspaceMCPServer()` - MCP server for Claude Desktop (NEW)
   - Direct action-to-tool mapping using `Object.entries`

3. **Removed All Custom Code**
   - Deleted `src/server/mcp.ts` (~165 lines)
   - Removed custom type definitions
   - Use SDK types directly

4. **Key Pattern: Actions ARE Tools**
   ```typescript
   // List tools - direct mapping
   server.setRequestHandler(ListToolsRequestSchema, async () => ({
     tools: Object.entries(actions).map(([name, action]) => ({
       name,
       title: name,
       description: action.description,
       inputSchema: action.input || { type: 'object', properties: {} }
     }))
   }));

   // Call tool - validate + execute
   server.setRequestHandler(CallToolRequestSchema, async (request) => {
     const action = actions[request.params.name];
     const handler = client[request.params.name];

     if (!action || !handler) throw new Error(`Unknown tool: ${request.params.name}`);

     const args = request.params.arguments || {};

     // TypeBox validation
     if (action.input && !Value.Check(action.input, args)) {
       const errors = [...Value.Errors(action.input, args)];
       throw new Error(`Invalid input: ${JSON.stringify(errors)}`);
     }

     // Execute handler
     const result = action.input ? await handler(args) : await handler();

     // Handle Result<T, E>
     if (result.error) {
       return {
         content: [{ type: 'text', text: JSON.stringify({ error: result.error.message }) }],
         isError: true
       };
     }

     return {
       content: [{ type: 'text', text: JSON.stringify(result.data) }],
       structuredContent: result.data
     };
   });
   ```

### Benefits Achieved

- ✅ **~100 lines** vs ~200+ before
- ✅ **No custom abstractions** - actions already have metadata
- ✅ **Official protocol compliance** - using SDK
- ✅ **TypeBox validation** - built-in with Value.Check
- ✅ **HTTP transport** - HTTP REST + MCP
- ✅ **Zero helper functions** - direct mapping

### Usage

**HTTP Server (existing):**
```typescript
import { createWorkspaceServer } from '@epicenter/server';
import workspace from './epicenter.config';

const app = await createWorkspaceServer(workspace);
Bun.serve({ fetch: app.fetch, port: 3001 });
```

**MCP Server (new):**
```typescript
import { createWorkspaceMCPServer } from '@epicenter/server';
import workspace from './epicenter.config';

await createWorkspaceMCPServer(workspace);
```

## TypeBox Utilities Needed

```typescript
import { Type, TSchema } from 'typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';

/**
 * Convert TypeBox schema to JSON Schema for MCP
 */
export function typeboxToJsonSchema(schema: TSchema): Record<string, any> {
  // TypeBox schemas ARE JSON Schema
  // Just need to serialize properly
  return JSON.parse(JSON.stringify(schema));
}

/**
 * Validate input against TypeBox schema
 */
export function validateInput<T extends TSchema>(
  schema: T,
  input: unknown
): { valid: true; data: Static<T> } | { valid: false; errors: string[] } {
  const compiled = TypeCompiler.Compile(schema);
  const errors = [...compiled.Errors(input)];

  if (errors.length > 0) {
    return {
      valid: false,
      errors: errors.map(e => `${e.path}: ${e.message}`)
    };
  }

  return { valid: true, data: input as Static<T> };
}
```

## Benefits

1. **Less code**: Remove ~50 lines of type definitions
2. **Better types**: Leverage existing TypeBox metadata
3. **Auto-validation**: Input validation for free
4. **Single source of truth**: Action schemas define both API and MCP
5. **Better DX**: Descriptions automatically flow through

## Trade-offs

- **Dependency**: Requires `@sinclair/typebox/compiler` for validation
- **Learning curve**: Team needs to understand TypeBox JSON Schema output
- **Breaking change**: If anyone is directly using the old MCP types (unlikely)

## Open Questions

1. Should we cache compiled TypeBox schemas for performance?
2. Do we need to support custom error messages for validation?
3. Should we auto-generate examples from TypeBox schemas?
