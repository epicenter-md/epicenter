# Arktype Composition Patterns

Three patterns for composing arktype schemas cleanly: n-ary unions, merge distribution, and deriving from constants.

## N-ary `type.or()` Instead of Chaining

When building a union of 3+ variants, use `type.or(a, b, c)` instead of chaining `.or().or().or()`. It accepts up to 16 arguments.

```typescript
// Good: flat, easy to scan
const transcriptionConfig = type.or(
	{ service: "'OpenAI'", model: "'whisper-1' | 'gpt-4o-transcribe'" },
	{ service: "'Groq'", model: "'whisper-large-v3' | 'whisper-large-v3-turbo'" },
	{ service: "'Deepgram'", model: "'nova-3' | 'nova-2'" },
	{ service: "'whispercpp'" },
);

// Bad: deeply nested chain
const transcriptionConfig = type({ service: "'OpenAI'", model: "..." })
	.or({ service: "'Groq'", model: "..." })
	.or({ service: "'Deepgram'", model: "..." })
	.or({ service: "'whispercpp'" });
```

The static form creates the union in a single call. The chained form creates intermediate union types at each step. For 2 variants, chaining is fine. For 3+, prefer `type.or()`.

## `base.merge(type.or(...))` for Discriminated Unions

When all variants share base fields, define the base as a `type()`, then merge it with a union of the variant-specific fields. `.merge()` distributes across the union. It applies to each branch automatically.

```typescript
const stepBase = type({
	id: 'string',
	transformationId: 'string',
	order: 'number',
	_v: '1',
});

const transformationStep = stepBase.merge(
	type.or(
		{
			type: "'prompt_transform'",
			'inference.provider': "'OpenAI'",
			'inference.model': "'gpt-4o'",
			systemPromptTemplate: 'string',
			userPromptTemplate: 'string',
		},
		{
			type: "'find_replace'",
			findText: 'string',
			replaceText: 'string',
			useRegex: 'boolean',
		},
	),
);
```

This replaces chaining `.and().and()` or repeating `base.merge(...)` per variant.

```typescript
// Bad: .and() chain
const step = stepBase
	.and({ type: "'prompt_transform'" })
	.and(inferenceProvider)
	.and({ systemPromptTemplate: 'string' });

// Bad: repeated merge
type.or(
	stepBase.merge({ type: "'prompt_transform'", ... }),
	stepBase.merge({ type: "'find_replace'", ... }),
);

// Good: merge distributes over union
stepBase.merge(type.or(
	{ type: "'prompt_transform'", ... },
	{ type: "'find_replace'", ... },
));
```

## `type.enumerated()`: Derive from Const Arrays

Use `type.enumerated()` to build string literal unions from existing `as const` arrays. This keeps schemas in sync with app constants.

```typescript
const RECORDING_MODES = ['manual', 'vad', 'upload'] as const;
const recordingMode = type.enumerated(...RECORDING_MODES);
// Same as: type("'manual' | 'vad' | 'upload'")
```

For rich object arrays, map to the field you need:

```typescript
const OPENAI_MODELS = [
	{ name: 'whisper-1', cost: '$0.36/hour' },
	{ name: 'gpt-4o-transcribe', cost: '$0.36/hour' },
] as const;

const openaiModel = type.enumerated(...OPENAI_MODELS.map((m) => m.name));
```

Combine with `type.or()` for discriminated unions where each variant derives its allowed values from a different constant array:

```typescript
const transcriptionConfig = type.or(
	{ service: "'OpenAI'", model: type.enumerated(...OPENAI_MODELS.map((m) => m.name)) },
	{ service: "'Groq'", model: type.enumerated(...GROQ_MODELS.map((m) => m.name)) },
	{ service: "'whispercpp'" },
);
```

## Summary

| Pattern | Use when | Instead of |
|---------|----------|------------|
| `type.or(a, b, c)` | 3+ union variants | `.or().or().or()` chains |
| `base.merge(type.or(...))` | Shared base + variant fields | `.and().and()` or repeated `base.merge()` |
| `type.enumerated(...arr)` | Deriving from `as const` arrays | Hand-written string literal unions |
