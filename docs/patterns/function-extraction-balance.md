# Function Extraction: Finding the Right Balance

Every function should ideally do one thing, but too many functions creates unnecessary indirection and cognitive overhead.

This is a key tension in code organization: what does "one thing" really mean? You shouldn't necessarily over extract functions so that they do one thing. You should think more about intent rather than imperative steps. In that way, functions do do one thing.

## The Problem

Consider the following code I wrote for building an MCP tool registry:

```typescript
async function buildMcpToolRegistry(client): Promise<Map<string, McpToolEntry>> {
  const entries = await Promise.all(
    iterActions(client).map(buildToolEntry)
  );
  return new Map(entries.filter((e) => e !== undefined));
}

async function buildToolEntry(info: ActionInfo): Promise<[string, McpToolEntry] | undefined> {
  const toolName = [info.workspaceId, ...info.actionPath].join('_');
  const inputSchema = await buildMcpInputSchema(info.action, toolName);
  if (!inputSchema) return undefined;
  return [toolName, { action: info.action, inputSchema }];
}

async function buildMcpInputSchema(action: Action, toolName: string): Promise<JSONSchema7 | undefined> {
  if (!action.input) return EMPTY_OBJECT_SCHEMA;
  const schema = await safeToJsonSchema(action.input);
  if (schema.type !== 'object' && schema.type !== undefined) {
    console.warn(`[MCP] Skipping tool "${toolName}": input has type "${schema.type}" but MCP requires "object".`);
    return undefined;
  }
  return schema;
}
```

Three functions. Each does "one thing." But is this better than two? One?

## The Heuristic

I ask two questions:

1. **Does the extracted function have real logic, or is it just glue?**
2. **Would inlining it make the parent function unreadable?**

Let's analyze each function:

**`buildToolEntry`** (5 lines): This is pure glue code. It joins strings, calls another function, returns a tuple. No branching logic, no validation, no side effects beyond what it delegates. The name doesn't tell me anything I can't see from the code itself.

**`buildMcpInputSchema`** (12 lines): This has real logic. It handles the empty-input case, validates the schema type, and logs a warning. But the warning is a single console.warn call, and the validation is a simple conditional. The "real logic" here is actually minimal.

## The Refactor

On closer inspection, the schema validation is straightforward enough to inline.

Think: does `buildToolEntry` or `buildMcpInputSchema` really do something? Or does it make the reader more confused? The result is a single function that reads top-to-bottom:

```typescript
async function buildMcpToolRegistry(client): Promise<Map<string, McpToolEntry>> {
  const entries = await Promise.all(
    iterActions(client).map(async ({ workspaceId, actionPath, action }) => {
      const toolName = [workspaceId, ...actionPath].join('_');

      // Build input schema - MCP requires object type at root
      if (!action.input) {
        return [toolName, { action, inputSchema: EMPTY_OBJECT_SCHEMA }] as const;
      }

      const schema = await safeToJsonSchema(action.input);
      if (schema.type !== 'object' && schema.type !== undefined) {
        console.warn(
          `[MCP] Skipping tool "${toolName}": input has type "${schema.type}" but MCP requires "object".`
        );
        return undefined;
      }

      return [toolName, { action, inputSchema: schema }] as const;
    }),
  );

  return new Map(entries.filter((e) => e !== undefined));
}
```

One function instead of three. The logic flows linearly: build tool name, handle empty input, validate schema, return entry or skip. No jumping between definitions.

## When to Extract

Extract a function when:
- It has meaningful branching logic or validation
- It has side effects worth naming (logging, I/O)
- It's reused in multiple places
- The parent function becomes unreadable without extraction

Keep code inline when:
- It's just data transformation (map, join, construct)
- The "function" is 3-5 lines of straight-line code
- Naming it doesn't add information beyond what the code shows
- It's only called in one place

## The Deeper Principle

"One function, one thing" is about mental chunking, not line counts. A function should represent one conceptual action, but not necessarily every step must be extracted into a smaller function. If that step is "build a tool entry from action info," and building a tool entry is trivial, then it's not worth naming.

The goal is code you can read top-to-bottom without constantly jumping to definitions. Sometimes that means more functions. Sometimes fewer.
