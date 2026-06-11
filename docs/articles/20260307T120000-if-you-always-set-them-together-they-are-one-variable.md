# If You Always Set Them Together, They Are One Variable

You have two reactive variables. Every time you assign one, you assign the other. You never update `status` without also updating `error`. They travel as a pair through every code path. That's a signal: they aren't two variables. They're one variable with two fields that you've accidentally split apart.

## The Smell

Here's the pattern in Svelte 5, but it applies to any reactive system: React `useState`, Vue `ref`, Solid signals, plain TypeScript:

```typescript
let status = $state<'idle' | 'loading' | 'success' | 'error'>('idle');
let error = $state('');

async function submit() {
  error = '';           // ← always paired
  status = 'loading';   // ← always paired

  const result = await doThing();

  if (result.error) {
    error = result.error.message;  // ← always paired
    status = 'error';              // ← always paired
  } else {
    status = 'success';  // ← what about error? hope you remembered
  }
}
```

Every assignment site touches both variables. And in the success branch, `error` keeps its old value. An empty string, sure, but only because you remembered to clear it at the top. The two variables are semantically coupled but syntactically independent. Nothing in the type system connects them. You can set `status = 'success'` while `error` still holds a message from a previous failure.

## The Fix

If two variables always change together, merge them into a discriminated union:

```typescript
type Phase =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success' }
  | { status: 'error'; error: string };

let phase = $state<Phase>({ status: 'idle' });

async function submit() {
  phase = { status: 'loading' };

  const result = await doThing();

  if (result.error) {
    phase = { status: 'error', error: result.error.message };
  } else {
    phase = { status: 'success' };
  }
}
```

One assignment. Both values change atomically. And `error` is only accessible when `status === 'error'`: you can't read a stale error from a success state because the type doesn't have that field.

No more cleanup lines. No more `error = ''` at the top of every function. The impossible state: success with an error message: is unrepresentable.

## The Test

Look at your assignment sites. If you see two `let` declarations and every function body assigns both of them together, they should be one `$state` with a discriminated union type.

The heuristic works in reverse too. If two pieces of state change independently. A form's `email` and `password` fields, say. They should stay separate. The test isn't "are they related?" It's "do they always change at the same time?"

## Beyond Reactive State

This isn't a Svelte pattern. It's a TypeScript pattern. Anywhere you see two variables that are always assigned together: function-scoped, module-scoped, class fields: ask whether they're actually one variable wearing a trench coat. The reactive context just makes the cost higher because stale state means stale UI.

---

**Related:** [Three Auth Modes, One Config Object, Zero Invalid States](./discriminated-unions-over-optional-fields.md) covers the same principle for config objects with mutually exclusive optional fields.
