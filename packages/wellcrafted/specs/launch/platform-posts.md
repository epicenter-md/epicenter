# Platform-Specific Launch Posts

## Hacker News

**Title**: Show HN: Well Crafted – Type-safe TypeScript errors without the learning curve

**Post**:
Hey HN! I built Well Crafted after spending a year with Effect-TS in production. While I loved Effect's ideas (Result types, tagged errors), the generator-based syntax and paradigm shift was too much for my team.

Well Crafted takes the best parts - type-safe error handling and serializable errors - but keeps familiar JavaScript patterns:

```typescript
const { data, error } = await readFile("config.json");
if (error) {
  console.log(error.message); // TypeScript knows this is safe
  return;
}
// TypeScript knows data is defined here
```

Key differences from Effect:
- Uses async/await, not generators
- Errors are plain objects (serialize over network/IPC)
- Zero dependencies, 4KB minified
- Incremental adoption (no framework lock-in)

The philosophy is simple: get 80% of Effect's benefits with 20% of the complexity. Perfect for teams who want better error handling without rewriting their codebase.

Docs: https://github.com/[yourusername]/wellcrafted
NPM: `npm install wellcrafted`

Would love your feedback, especially if you've tried Effect and found it too heavy!

---

## Reddit (r/typescript)

**Title**: I built a lightweight alternative to Effect-TS for type-safe error handling

**Post**:
After using Effect-TS in production and loving the concepts but struggling with the complexity, I built Well Crafted - a library that brings Result types and tagged errors to TypeScript without the paradigm shift.

**The problem**: JavaScript's try/catch hides errors and breaks across serialization boundaries.

**The solution**: Explicit Result types with a familiar API:

```typescript
import { tryAsync } from "wellcrafted";

// Wrap any async operation
const { data, error } = await tryAsync({
  try: () => fetch('/api/data'),
  mapErr: (e) => Err({
    name: "NetworkError",
    message: "Request failed",
    context: { url: '/api/data' },
    cause: e
  })
});
```

**Why not Effect?** Effect is powerful but requires learning generators, new concepts like "fibers", and basically a new way of writing TypeScript. Well Crafted gives you:
- Result types with the `{ data, error }` pattern (like Supabase)
- Plain object errors that serialize perfectly
- Zero dependencies
- Works with your existing async/await code

Check it out: https://github.com/[yourusername]/wellcrafted

Curious what the community thinks - is there room for a "lighter Effect"?

---

## Twitter Thread

**Tweet 1**:
Spent 2 years with Effect-TS. Loved the ideas, fought the syntax.

So I built Well Crafted: Effect's best parts (Result types, tagged errors) without the learning curve.

One simple idea: what if type-safe errors worked with the JavaScript you already know?

🧵

**Tweet 2**:
The problem: `try/catch` lies to you

```ts
async function getUser(): Promise<User> {
  // This can throw 5 different ways
  // But the type signature pretends it can't
}
```

Your 3am production error doesn't care about your types.

**Tweet 3**:
Well Crafted's approach: make errors visible

```ts
async function getUser(): Promise<Result<User, NetworkError>> {
  return tryAsync({
    try: () => fetch(url),
    mapErr: (e) => Err({ 
      name: "NetworkError",
      message: "Failed", 
      context: { url }
    })
  });
}
```

**Tweet 4**:
Use it like Supabase or any modern SDK:

```ts
const { data, error } = await getUser();
if (error) {
  // TypeScript knows error exists
  log(error.context);
  return;
}
// TypeScript knows data is User
```

No generators. No fibers. Just async/await.

**Tweet 5**:
Why not Effect? 

Effect is brilliant but asks you to rewrite everything. New execution model, generator functions everywhere, massive API surface.

Well Crafted: 
- 0 dependencies
- 4KB minified  
- Use it in one function or your whole app
- Your team already knows how to use it

**Tweet 6**:
The best part? Errors that actually serialize:

```ts
// This works across workers, IPC, network
const error = {
  name: "ValidationError",
  message: "Invalid email",
  context: { field: "email" },
  cause: undefined
};
```

No more instanceof breaking in production.

**Tweet 7**:
Available now:
```
npm install wellcrafted
```

Docs: https://github.com/[yourusername]/wellcrafted

Built for teams who want Effect's benefits without the PhD in functional programming.

Because great software is well crafted, not over-engineered.