# When Object.defineProperty Beats Proxy

You have a complex object you want to wrap. Maybe it's from a library you don't control. Maybe you want to add some custom behavior on top. Your first instinct: reach for Proxy.

Proxy feels like the right tool. It's powerful, flexible, designed exactly for this. But it's not always the best choice.

## The Proxy Approach

We were wrapping YJS Y.Map objects in a schema validation system. We wanted to provide type-safe property access and serialization on top of the underlying map. A Proxy seemed perfect.

Here's what that looked like:

```typescript
const proxy = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'toJSON') {
        return () => {
          const result: Record<string, unknown> = {};
          for (const key in schema) {
            const value = yrow.get(key);
            if (value !== undefined) {
              result[key] = serializeCellValue(value);
            }
          }
          return result as SerializedRow<TSchema>;
        };
      }

      if (prop === '$yRow') {
        return yrow;
      }

      if (typeof prop === 'string') {
        return yrow.get(prop);
      }

      return undefined;
    },

    has(_target, prop) {
      if (prop === 'toJSON' || prop === '$yRow') return true;
      return yrow.has(prop as string);
    },

    ownKeys(_target) {
      return [...yrow.keys(), 'toJSON', '$yRow'];
    },

    getOwnPropertyDescriptor(_target, prop) {
      if (prop === 'toJSON' || prop === '$yRow') {
        return {
          configurable: true,
          enumerable: false,
          writable: false,
        };
      }
      if (typeof prop === 'string' && yrow.has(prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
        };
      }
      return undefined;
    },
  },
) as Row;
```

Four trap handlers. Each one has conditional logic. The `get` trap alone has three different branches. The `getOwnPropertyDescriptor` trap constructs descriptor objects. It works, but there's a lot of machinery.

## The Console Inspection Problem

Try logging that object:

```typescript
const wrapped = proxy;
console.log(wrapped);
```

Output:

```
{}
```

Empty. The Proxy doesn't have actual properties for console.log to inspect. Even though `ownKeys` and `getOwnPropertyDescriptor` are properly implemented, the inspection isn't reliable. In the browser dev tools, you can't expand the object to see what's inside.

When debugging, this is frustrating. You can't see the actual shape of your data. You have to manually access specific properties you think might exist.

## The Object.defineProperty Alternative

We switched to this approach:

```typescript
function buildRowFromYRow<TSchema extends TableSchema>(
  yrow: YRow,
  schema: TSchema,
): Row<TSchema> {
  const descriptors = Object.fromEntries(
    Array.from(yrow.keys()).map(key => [
      key,
      {
        get: () => yrow.get(key),
        enumerable: true,
        configurable: true,
      },
    ]),
  );

  const row: Record<string, unknown> = {};
  Object.defineProperties(row, descriptors);

  // Add special properties as non-enumerable
  Object.defineProperties(row, {
    toJSON: {
      value: () => {
        const result: Record<string, unknown> = {};
        for (const key in schema) {
          const value = yrow.get(key);
          if (value !== undefined) {
            result[key] = serializeCellValue(value);
          }
        }
        return result as SerializedRow<TSchema>;
      },
      enumerable: false,
      configurable: true,
    },
    $yRow: {
      value: yrow,
      enumerable: false,
      configurable: true,
    },
  });

  return row as Row<TSchema>;
}
```

This does the same thing. Iterate over the keys. Create a getter for each one that delegates to `yrow.get(key)`. Add special non-enumerable properties. That's it.

Now when you log it:

```typescript
const wrapped = buildRowFromYRow(yrow, schema);
console.log(wrapped);
```

You see:

```
{
  id: "cx8wMkbSogst1KAJlCFL9",
  pageId: "1E0ZJKm3DC5mBUcqE8umN",
  title: "Building Open Source Transcription Tools on a Budget",
  description: "...",
  niche: "coding",
  postedAt: Y.Text {...},
  updatedAt: DateWithTimezone {...}
}
```

All the properties. All the actual types. Inspection works naturally.

## The Difference

**Proxy version:**
- Four trap handlers with conditional logic
- ~60 lines of code
- Console shows `{}`
- Complex interception for each operation

**Object.defineProperty version:**
- One loop that builds getters
- ~52 lines of code
- Console shows the actual object shape
- Declarative property definitions

Same functionality. The getters still call `yrow.get(key)` every time, so changes are reflected. The difference is that one is transparent and the other requires you to understand how Proxies work to debug it.

## When to Use Each

Proxy has legitimate use cases. Use it when you need to intercept operations you don't know about at definition time, or when you need to handle dynamic properties that might not exist in the underlying object.

Object.defineProperty is better when you know your property names upfront (or can enumerate them) and you want normal debugging to work. You get better console inspection, simpler code, and the same delegation behavior.

In our case, we knew what we were wrapping. The schema defined the properties. We didn't need Proxy's full power. We just needed getters that delegated to the underlying Y.Map. Object.defineProperty did that with less code and better debuggability.

## The Takeaway

Proxy is a powerful tool, but it's not the default solution for object wrapping. Before reaching for it, ask: do I actually need to intercept operations I don't know about? Or do I just need to delegate property access to an underlying object?

If it's the latter, Object.defineProperty is simpler and more inspectable. Your debugging experience will thank you.
