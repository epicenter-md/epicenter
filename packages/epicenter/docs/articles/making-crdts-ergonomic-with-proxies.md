# Making Y.js CRDTs Feel Like Native JavaScript

**Note**: Have an agent update this doc later once Epicenter's Row Proxy design stabilizes.

I was building Epicenter, a local-first database that uses Y.js for collaborative editing, when I hit an ergonomics problem. Y.js is powerful, it gives you CRDTs (Conflict-free Replicated Data Types) that enable real-time collaboration without a central server. But the API is verbose and lacks type safety.

Here's what working with Y.js looks like:

```typescript
const yrow = ytable.get('user-123');
const name = yrow.get('name');
const age = yrow.get('age');
yrow.set('email', 'alice@example.com');

// Need external helper functions
const json = serializeRow(yrow);
const validation = validateRow(yrow, schema);
```

That's a lot of `.get()` and `.set()` calls. TypeScript has no idea what properties exist or what types they have. You need external functions for common operations like serialization and validation. If you're building a database, you're writing this code constantly, and it gets tedious fast.

I wanted something that felt native:

```typescript
const row = table.get('user-123').row;
const name = row.name;        // TypeScript knows this is string
const age = row.age;          // TypeScript knows this is number
row.email = 'alice@example.com';

const json = row.toJSON();
const validation = row.validate();
```

Clean property access, full TypeScript inference, convenient methods. The question was how to bridge the gap without losing the CRDT behavior underneath.

## The Proxy Insight

JavaScript Proxies intercept operations on objects. You can trap property access, assignment, enumeration, and more. This made them perfect for wrapping YRows: the outside looks like a regular object, but under the hood, every operation goes through the Y.js CRDT.

The basic idea is straightforward. Create a Proxy that intercepts property reads and forwards them to `yrow.get()`:

```typescript
const proxy = new Proxy({}, {
  get(_target, prop) {
    return yrow.get(prop);
  }
});
```

But there's a subtlety that took me a moment to realize. I wanted to add methods like `.validate()` and `.toJSON()` that return validation results or serialized data. The tricky part is that `.validate()` needs to return both validation status and a reference to the row itself for convenience:

```typescript
const result = row.validate();
// result = { status: 'valid', row: row }  // row needs to reference itself!
```

You can't return `this` from the method because there is no `this`, it's all Proxy traps. The solution is to store a reference to the Proxy itself:

```typescript
export function createRow({ yrow, schema }) {
  let proxy;

  proxy = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'validate') {
        return () => {
          // Run validation logic...
          return { status: 'valid', row: proxy }; // Can reference self!
        };
      }

      if (prop === 'toJSON') {
        return () => {
          const json = {};
          for (const [key, value] of yrow.entries()) {
            json[key] = value;
          }
          return json;
        };
      }

      if (prop === '$yRow') {
        return yrow; // Escape hatch to access underlying YRow
      }

      // Default: access YRow property
      return yrow.get(prop);
    },

    // Other traps for proper object behavior
    has(_target, prop) {
      return yrow.has(prop);
    },

    ownKeys(_target) {
      return Array.from(yrow.keys());
    },

    getOwnPropertyDescriptor(_target, prop) {
      if (yrow.has(prop)) {
        return {
          enumerable: true,
          configurable: true,
          value: yrow.get(prop),
        };
      }
    },
  });

  return proxy;
}
```

Storing the Proxy reference in a closure lets methods return it. This means `.validate()` can return `{ status: 'valid', row: proxy }` where `proxy` is the same Proxy the user is working with. It's self-referential in a clean way.

The other traps (`has`, `ownKeys`, `getOwnPropertyDescriptor`) make the Proxy behave properly with operations like `Object.keys()`, `Object.entries()`, and the `in` operator. Without these, your "object" won't enumerate correctly.

## The TypeScript Magic

The TypeScript part is what makes this really shine. You can define a type that represents the row with full inference:

```typescript
type Row<TSchema extends TableSchema> = {
  readonly [K in keyof TSchema]: ColumnSchemaToCellValue<TSchema[K]>;
} & {
  toJSON(): SerializedRow<TSchema>;
  validate(): ValidationResult<TSchema>;
  readonly $yRow: YRow;
};
```

This maps your schema definition directly to TypeScript types. If your schema says `{ name: text(), age: number() }`, TypeScript knows that `row.name` is a string and `row.age` is a number. The mapped type handles the property inference, and the intersection adds the helper methods.

From the user's perspective, this means autocomplete works perfectly, type errors are caught at compile time, and refactoring is safe. The CRDT complexity is hidden behind an API that feels native.

## Why This Matters

CRDTs are powerful but historically have been hard to use. The Y.js API reflects the underlying complexity: you're dealing with specialized data structures, not plain objects. That's fine for library internals, but it leaks into application code.

Using Proxies, you can hide that complexity without sacrificing functionality. Property access has zero runtime overhead beyond what Y.js already does. You get the collaborative editing guarantees of CRDTs with the ergonomics of regular JavaScript objects. TypeScript inference means compile-time safety for your data layer.

This pattern isn't specific to Y.js or databases. Any time you have a powerful but verbose library, Proxies let you build ergonomic wrappers. The key insights are:

1. Store the Proxy reference when you need self-referencing methods.
2. Implement all the enumeration traps for proper object behavior.
3. Use TypeScript's mapped types to infer property types from your schema.
4. Provide an escape hatch (like `$yRow`) for direct access when needed.

The lesson I took away: sometimes the best abstractions are invisible. Users of Epicenter work with objects, methods, and type-safe properties. The fact that it's all CRDT magic underneath doesn't matter to them. Proxies make that possible without runtime overhead or API compromises.

If you're building on top of powerful but low-level libraries, consider whether Proxies can give you a cleaner surface API. The JavaScript runtime does the heavy lifting, you get type safety, and your users get ergonomics that feel native. That's a win all around.
