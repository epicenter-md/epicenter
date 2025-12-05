# Programmatically Generating CLIs from Validators: Convert to JSON Schema First, then Introspect

I wanted to generate yargs CLI commands from type definitions. The goal: define a schema once, use it for both runtime validation and CLI argument parsing.

## The Problem

Most validation libraries (ArkType, Zod, Valibot) implement Standard Schema V1, which is great for validation. But there's no standard way to introspect them. Each library has its own internal structure:

- ArkType has its own AST representation
- Zod has `.shape` and `._def` internals
- TypeBox has `~kind` properties
- Valibot has yet another structure

Writing converters for each library means maintaining library-specific code that breaks when internals change.

## The Solution: Standard JSON

Instead of introspecting validation libraries directly, I used `@standard-community/standard-json` to convert any Standard Schema to JSON Schema first. Then I introspect/convert that representation into yargs CLI commands.

```typescript
import { toJsonSchema } from '@standard-community/standard-json';
import { type } from 'arktype';

// Define schema with ArkType
const schema = type({
  name: 'string',
  age: 'number',
  role: "'admin' | 'user' | 'guest'"
});

// Convert to JSON Schema
const jsonSchema = await toJsonSchema(schema);

// Now introspect the standardized JSON Schema structure
if (jsonSchema.type === 'object' && jsonSchema.properties) {
  for (const [key, propSchema] of Object.entries(jsonSchema.properties)) {
    // Generate yargs options from JSON Schema
  }
}
```

## Why This Works

JSON Schema is a stable, well-documented standard. Once you have JSON Schema, introspection is straightforward:

- `type`: "string" | "number" | "boolean" | "array" | "object" | "null"
- `enum`: Array of literal values
- `anyOf` / `oneOf`: Union types
- `required`: Array of required property names
- `properties`: Object properties

This approach works with **any** Standard Schema library. Switch from ArkType to Zod? The converter still works. No library-specific code needed.

## Implementation

The full implementation in `standardschema-to-yargs.ts`:

1. Convert Standard Schema → JSON Schema via `toJsonSchema()`
2. Iterate over `properties` to find fields
3. Check `required` array to determine if field is required
4. Map JSON Schema types to yargs types:
   - `"string"` → `type: 'string'`
   - `"number"` | `"integer"` → `type: 'number'`
   - `"boolean"` → `type: 'boolean'`
   - `"array"` → `type: 'array'`
   - String literal unions → `choices: [...]`
   - Everything else → omit type, accept any value

## The Permissive Philosophy

For complex types (objects, mixed unions, etc), we still create the CLI option. We just omit the `type` parameter in yargs, which makes it accept any value.

```typescript
// For complex schemas
yargs.option('data', {
  description: 'Object type (validation at runtime)',
  demandOption: true,
  // No 'type' specified - yargs accepts anything
});
```

Validation happens when the action runs via Standard Schema. The CLI is permissive; the schema validator is strict.

## Benefits

- **Library agnostic**: Works with ArkType, Zod, Valibot, any Standard Schema V1 library
- **Future proof**: Relies on JSON Schema standard, not library internals
- **Best effort**: Creates CLI options for all fields, even complex ones
- **Simple**: One converter for all validation libraries
- **Maintainable**: No need to update when libraries change internals

## Example Usage

```typescript
import { type } from 'arktype';
import yargs from 'yargs';
import { standardSchemaToYargs } from './standardschema-to-yargs';

const createPostSchema = type({
  title: 'string',
  content: 'string?',
  category: "'tech' | 'personal' | 'tutorial'"
});

// Generate CLI from schema
const cli = await standardSchemaToYargs(createPostSchema, yargs());

// Results in CLI with:
// --title (required string)
// --content (optional string)
// --category (required, choices: tech, personal, tutorial)
```

The same schema validates API requests, generates TypeScript types, and creates CLI interfaces. Define once, use everywhere.
