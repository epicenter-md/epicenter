---
name: arktype
description: 'The arktype conventions this repository has chosen: optional-key syntax that keeps JSON Schema conversion working, wrapping extracted types with type(), letting a schema value and its inferred type share one name, and deriving unions from const arrays with type.enumerated(). Use when defining or reviewing arktype schemas, command and event types, or workspace schema constants. Do not use for arktype syntax questions such as .merge(), .or(), or spread keys; ask DeepWiki against arktypeio/arktype for those.'
metadata:
  author: epicenter
  version: '2.0'
---

## Reference Repositories

- [arktype](https://github.com/arktypeio/arktype) : TypeScript-native runtime validation

## Upstream Grounding

Composition operators, spread keys, discriminant detection, and merge semantics
are upstream behavior. Ask DeepWiki a narrow question against
`arktypeio/arktype`, then verify against local installed types before changing
code. This file keeps no copy of that syntax, because a pinned example rots
against a library whose whole surface is its syntax.

What follows is the part DeepWiki cannot tell you: what this repository decided.

## Use `'key?'`, Never `| undefined`

Optional properties use arktype's `'key?'` syntax. An explicit `| undefined`
union on a required key breaks JSON Schema conversion, which is what the
workspace schemas and command contracts are converted to.

```typescript
// Good: optional property syntax
commandBase.merge({
	action: "'openTab'",
	url: 'string',
	'windowId?': 'string',
	'result?': type({ tabId: 'string' }).or('undefined'),
});

// Bad: explicit undefined union on a required key
commandBase.merge({
	action: "'openTab'",
	url: 'string',
	windowId: 'string | undefined', // Breaks JSON Schema
});
```

`'result?': type({...}).or('undefined')` combines both deliberately: the `?`
makes the key optional and `.or('undefined')` allows an explicitly undefined
value when the key is present. That is the shape for "pending is absent, done
has a value," where absent and explicitly-empty mean different things.

## Wrap Extracted Types With `type()`

When extracting a reusable arktype type into a named constant, wrap it with
`type()` even for a plain string literal union. Both forms work inside a
`type({...})` object literal because arktype coerces strings, so the bad version
passes review easily and then fails the first time someone reaches for `.infer`,
`.or()`, or `.merge()` on it.

```typescript
// Good: a real Type, composable in every position
const tabGroupColor = type(
	"'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'",
);

// Bad: a plain string, no .infer, cannot compose
const tabGroupColor =
	"'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'";
```

## Let A Schema Value And Its Inferred Type Share One Name

TypeScript keeps value space and type space separate, so one identifier can
validate at runtime and annotate at compile time. Import it once.

```typescript
// Good: one import covers both namespaces
import { WorkspaceId } from './workspace-id';

const Session = type({ workspaceId: WorkspaceId });

type SessionResponse = { workspaceId: WorkspaceId };
```

```typescript
// Bad: an artificial Schema suffix to make room for the type import
import { WorkspaceId as WorkspaceIdSchema, type WorkspaceId } from './workspace-id';
```

Alias only when two imported values genuinely collide in the same namespace. A
runtime schema and its own inferred type never do.

## Derive Unions From Const Arrays With `type.enumerated()`

A model list or mode list that exists as an `as const` array in app code should
not be retyped as a string union in the schema. Two lists drift, and the schema
is the one that silently accepts a value the app cannot handle.

```typescript
const RECORDING_MODES = ['manual', 'vad', 'upload'] as const;

const recordingMode = type.enumerated(...RECORDING_MODES);
// Equivalent to: type("'manual' | 'vad' | 'upload'")
```

When the constants are objects, map to the identifying field first:

```typescript
const openaiModel = type.enumerated(
	...OPENAI_TRANSCRIPTION_MODELS.map((m) => m.name),
);
```

The same derivation works inside a discriminated union, where each variant's
model field comes from its own constant array and a variant may have no model
field at all:

```typescript
const transcriptionConfig = type.or(
	{ service: "'OpenAI'", model: type.enumerated(...OPENAI_MODELS.map((m) => m.name)) },
	{ service: "'Groq'", model: type.enumerated(...GROQ_MODELS.map((m) => m.name)) },
	{ service: "'whispercpp'" }, // local: no model field
);
```
