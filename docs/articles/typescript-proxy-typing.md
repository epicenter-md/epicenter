# TypeScript Proxies: They Look Like Functions, But Type Them Like Objects

I hit an interesting TypeScript pattern that confused me for a while.

Here's the thing: when you create a Proxy in JavaScript, you write code that looks and feels like defining a function. You're implementing handlers, intercepting property access, defining behavior. It reads like functional programming.

```typescript
const proxy = new Proxy({}, {
  get(_target, prop) {
    // This feels like a function
    if (prop === 'toJSON') {
      return () => ({ serialized: true });
    }
    return ymap.get(prop);
  }
});
```

But here's what took me too long to realize: **you type it like an object**.

```typescript
type Row<TTableSchema extends TableSchema> = {
  readonly [K in keyof TTableSchema]: ColumnSchemaToCellValue<TTableSchema[K]>;
} & {
  toJSON(): SerializedRow<TTableSchema>;
  validate(): RowValidationResult<Row<TTableSchema>>;
  readonly $yMap: YRow;
};
```

No special Proxy type. No handler signatures. Just a plain object type with the properties and methods your Proxy will expose.

Why? Because that's literally what a Proxy is: an object that intercepts operations. You access it like `row.title`. You call methods like `row.toJSON()`. TypeScript types what users see, not how you built it.

The implementation details (the get/set handlers, the target object, the trap mechanisms) don't leak into the type system. From TypeScript's perspective, if it walks like an object and quacks like an object, type it like an object.

This pattern shows up everywhere: mock implementations, lazy initialization, validation wrappers. You write handler logic in the Proxy constructor, but you describe the API surface as a simple object type.

The lesson: Don't overthink Proxy types. Type the interface, not the implementation.

---

Real-world example from my codebase: wrapping a YJS Map (Y.Map) to provide type-safe property access to database rows. The Proxy intercepts every property access and delegates to the underlying Y.Map, but from TypeScript's perspective, it's just an object with typed properties.

```typescript
export function createRow<TTableSchema extends TableSchema>({
  ymap,
  schema,
}: {
  ymap: YRow;
  schema: TTableSchema;
}): Row<TTableSchema> {
  const proxy: Row<TTableSchema> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'toJSON') {
          return () => {
            // Serialize Y.Map to plain object
            const result: Record<string, unknown> = {};
            for (const key in schema) {
              const value = ymap.get(key);
              if (value !== undefined) {
                result[key] = serializeValue(value);
              }
            }
            return result as SerializedRow<TTableSchema>;
          };
        }

        if (prop === '$yMap') {
          return ymap;
        }

        // Get value from Y.Map
        if (typeof prop === 'string') {
          return ymap.get(prop);
        }

        return undefined;
      },
    },
  ) as Row<TTableSchema>;

  return proxy;
}
```

Usage:

```typescript
type PostSchema = {
  id: { type: 'id' };
  title: { type: 'text'; nullable: false };
  content: { type: 'ytext'; nullable: false };
};

const row: Row<PostSchema> = createRow({ ymap, schema });

// Type-safe property access
console.log(row.title);        // string
console.log(row.content);      // Y.Text

// Method calls
const serialized = row.toJSON(); // SerializedRow<PostSchema>
const underlying = row.$yMap;    // YRow (Y.Map)
```

The Proxy intercepts everything, but TypeScript just sees a nicely typed object.
