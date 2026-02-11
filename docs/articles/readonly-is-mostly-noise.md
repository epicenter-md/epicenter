# `readonly` Is Mostly Noise (Except for Arrays)

**TL;DR**: Stop prefixing every property with `readonly`.  Use it only on arrays, maps, and when matching external interfaces. The modifier is shallow and provides little protection elsewhere.

## The Problem

```typescript
// This is exhausting to read
type Config = {
	readonly version: number;
	readonly vendor: string;
	readonly enabled: boolean;
	readonly timeout: number;
	readonly items: readonly string[];
};
```

Five `readonly` modifiers. One of them matters.

When you mutate `config.version = 2`, TypeScript yells at you. But you weren't going to do that anyway. You don't accidentally reassign string properties on objects you received from somewhere.

What you _do_ accidentally mutate is arrays:

```typescript
function processItems(config: Config) {
	config.items.push('oops'); // This mutates the original
	config.items.sort(); // So does this
}
```

## The Rule

Use `readonly` only when mutation is a realistic footgun:

```typescript
type Config = {
	version: number;
	vendor: string;
	enabled: boolean;
	timeout: number;
	items: readonly string[]; // This one matters
};
```

90% of the time, that's arrays. Occasionally `ReadonlyMap` or `ReadonlySet`. Never primitives.

## `readonly` Is Shallow

The `readonly` modifier only prevents reassignment, not mutation of contents:

```typescript
type Config = {
	readonly settings: { theme: string; debug: boolean };
};

config.settings = { theme: 'dark', debug: true }; // blocked
config.settings.theme = 'dark'; // still allowed
```

For objects, `readonly` doesn't protect you from the real footgun (nested mutation). For arrays, it does:

```typescript
type Config = {
	items: readonly string[];
};

config.items = ['new']; // allowed (reassignment)
config.items.push('oops'); // blocked
config.items.sort(); // blocked
```

This is why `readonly` in front of objects is mostly theater; the shallow protection rarely prevents the bugs you'd actually write.

## The Exception

When implementing types from upstream libraries (standard-schema, etc.), match their types exactly. If they declare `readonly version: 1`, you do too. Type compatibility trumps style preferences.

## Why This Matters

Every `readonly` modifier is a word your brain has to process. When everything is `readonly`, nothing stands out. When only arrays are `readonly`, it signals: "watch out, this one bites."

| Property Type | `readonly` Worth It? | Why                                              |
| ------------- | -------------------- | ------------------------------------------------ |
| Primitives    | No                   | You don't accidentally reassign `config.version` |
| Objects       | No                   | Shallow; doesn't prevent nested mutation         |
| Arrays        | Yes                  | Prevents `.push()`, `.sort()`, `.splice()`       |
| Maps/Sets     | Yes                  | Prevents `.set()`, `.delete()`, `.clear()`       |
