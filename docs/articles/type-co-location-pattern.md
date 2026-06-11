2025-11-14T09:35:56.389Z

# The Case Against catch-all `types.ts`: Why I Co-locate Types with Their Implementations

I was refactoring a database schema system when I opened `types.ts` and stared at 750 lines of type definitions. DateTime types at the top. Validator types in the middle. Column schemas. Row types. Validation result types. Everything that vaguely related to "data" lived in this one file.

But here's the weird part: the DateTime functions lived in `datetime.ts`. The validator functions lived in `validation.ts`. The ID generation function lived in `id.ts`. Why were the types separated from their implementations?

This should have been obvious, but it took me way too long to realize: **types don't need their own file just because they're types**.

## The Discoverability Problem

Let me show you what I mean. Here's what the file tree looked like:

```
src/schema/
├── types.ts (750+ lines)
├── validation.ts
├── datetime.ts
├── id.ts
└── ... other files
```

And here's what `types.ts` contained (simplified):

```typescript
// types.ts

// DateTime types
export type DateTimeString = `${string}Z|${string}` & Brand<'DateTimeString'>;

// Validator types
export type TableValidators<T> = {
	validateRow: (row: T) => YRowValidationResult;
	// ... more validators
};

export type YRowValidationResult =
	| { valid: true; row: YRow }
	| { valid: false; reasons: ValidationReason[] };

export type ValidationReason = {
	// ... validation reason structure
};

// Column schema types
export type ColumnSchema = {
	// ... column definition
};

// Row types
export type YRow = {
	// ... row structure
};

// ... 700 more lines of mixed type definitions
```

Now imagine you're trying to understand how validation works. You open `validation.ts`:

```typescript
// validation.ts
import type { TableValidators, YRowValidationResult } from './types';

export function createValidators(): TableValidators {
	return {
		validateRow: (row) => {
			// validation logic
		},
	};
}
```

What is `TableValidators`? You have to jump to `types.ts`. Okay, you find it. But wait, what's `YRowValidationResult`? Jump back to `types.ts`. Scroll around. Find it. What about `ValidationReason`? Back to `types.ts` again.

You're not reading code anymore. You're playing ping-pong between two files.

And `types.ts` doesn't help you. It's 750 lines of everything. DateTime types are mixed with validator types are mixed with schema types. There's no narrative. No story. Just a dump of type definitions.

## The Realization

Here's the thing that took me too long to realize: **types are documentation for the code that uses them**.

When you're reading `validation.ts`, you want to understand how validation works. The types are part of that story. `TableValidators` tells you what shape the validator object has. `YRowValidationResult` tells you what validation returns. These types aren't separate from the validation logic. They're integral to understanding it.

So why are they in a different file?

The answer I kept telling myself: "Because they're types, and types go in `types.ts`."

But that's not a reason. That's just a pattern I'd seen in other codebases and never questioned.

## The Refactor

I started co-locating types with their implementations:

```typescript
// validation.ts
export type TableValidators<T> = {
	validateRow: (row: T) => YRowValidationResult;
	// ... more validators
};

export type YRowValidationResult =
	| { valid: true; row: YRow }
	| { valid: false; reasons: ValidationReason[] };

export type ValidationReason = {
	// ... validation reason structure
};

export function createValidators(): TableValidators {
	return {
		validateRow: (row) => {
			// validation logic
		},
	};
}
```

Same with DateTimeString:

```typescript
// datetime.ts
export type DateTimeString = `${DateIsoString}|${TimezoneId}` &
	Brand<'DateTimeString'>;

export const DateTimeString = {
	parse(str: DateTimeString): Temporal.ZonedDateTime {
		/* ... */
	},
	stringify(dt: Temporal.ZonedDateTime): DateTimeString {
		/* ... */
	},
	is(value: unknown): value is DateTimeString {
		/* ... */
	},
	now(timezone?: string): DateTimeString {
		/* ... */
	},
};
```

And IDs:

```typescript
// id.ts
export type Id = string & { readonly __brand: 'Id' };

export function generateId(): Id {
	return crypto.randomUUID() as Id;
}
```

The new file tree:

```
src/schema/
├── types.ts (core schema types only)
├── validation.ts (validator types + functions)
├── datetime.ts (DateTimeString type + companion object)
├── id.ts (Id type + generation function)
└── ... other files
```

`types.ts` still exists, but now it only contains genuinely foundational types that are used across multiple modules:

```typescript
// types.ts
export type ColumnSchema = {
	// Core column definition used everywhere
};

export type TableSchema = {
	// Core table definition used everywhere
};

export type YRow = {
	// Core row structure used everywhere
};
```

These are the types that don't "belong" to any single implementation. They're the shared vocabulary of the schema system.

## What Changed

The difference in discoverability is dramatic. Now when I open `validation.ts`, I see the complete picture:

- What types the validators use
- What the validators return
- How the validators work

I don't have to jump to another file. I don't have to search through 750 lines of mixed type definitions. Everything I need is right there.

Same with DateTimeString. Same with IDs. The type and its implementation are co-located. They tell a single, coherent story.

## The Counter-Argument

You might be thinking: "But what if a type is used in multiple files?"

That's a fair question. And here's what I found: most types aren't actually used across multiple files. `TableValidators` is only used by validation code. DateTimeString types are only used by DateTimeString functions and maybe one or two utility functions.

When a type really is shared across multiple unrelated modules, then yeah, it probably belongs in a shared types file. But that's the exception, not the rule.

The real test is: "If I'm trying to understand this module, do I need to see this type?" If yes, co-locate it. If no, it probably belongs somewhere else anyway.

## When to Break the Rule

I kept `types.ts` for core schema types like `ColumnSchema`, `TableSchema`, and `YRow`. These are used everywhere. They're the foundation. It would be weird to have `ColumnSchema` live in, say, `validation.ts` just because validators use it.

But `TableValidators`? That's validation-specific. It belongs in `validation.ts`.

The heuristic I landed on: if removing this file would make exactly one other file harder to understand, the type belongs in that file.

## The Broader Pattern

This isn't really about types. It's about proximity.

When you're reading code, you're building a mental model. You're asking questions: "What does this function do? What does it return? What are the edge cases?"

Every time you have to jump to another file, you're interrupting that process. You're context-switching. You're paying a cognitive tax.

Co-locating related code minimizes that tax. The type, the implementation, the tests. If they're all part of the same story, they should live together.

I've seen this pattern in other contexts too. React components that export their prop types. GraphQL resolvers that export their type definitions. Database models that export their validation schemas.

The principle is the same: keep related things close.

## The Lesson

Not every data access layer needs a service. Not every type needs its own file.

I spent years putting types in `types.ts` because that's what I'd seen in other codebases. It never occurred to me to question whether that separation actually helped.

Turns out, it didn't. The types were documentation for specific implementations, and separating them made both harder to understand.

Now when I'm organizing TypeScript code, I ask: "If I'm trying to understand this module, what do I need to see?" Types usually make that list. So they get co-located.

The result is code that's easier to navigate, easier to understand, and easier to modify. No more jumping between files. No more 750-line type dumps. Just coherent modules that tell complete stories.

There's an even stronger version of this argument: most types shouldn't be manually declared at all. See [Types Should Be Computed, Not Declared](./types-should-be-computed-not-declared.md).
