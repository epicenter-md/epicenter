# The Default Generics Pattern: Why Libraries Use `T = unknown`

If you've ever dug into the source code of libraries like TanStack Query, Zod, or tRPC, you might have noticed something peculiar: generic types with defaults like `T = unknown` or `T = any`. Why do library authors write types this way? Why not just require the type parameter?

```typescript
// You might see patterns like this:
type QueryFn<TData = unknown, TContext = unknown> = {
  // ...
}

// Or plugin systems with defaults:
type Plugin<TConfig = unknown, TMethods = unknown> = {
  id: string;
  config: TConfig;
  methods: TMethods;
}

```

This pattern isn't accidental or sloppy. It's a deliberate design choice that enables powerful type composition and makes libraries more extensible. Let me explain why.

## The Problem: Constraining Without Knowing

Imagine you're building a plugin system. Other developers need to write functions that work with "any plugin" without knowing the specific types. Consider this scenario:

```typescript
// Without the pattern - THIS DOESN'T WORK
type Plugin<TConfig, TMethods> = {
  id: string;
  config: TConfig;
  methods: TMethods;
}

// Someone tries to write a function that accepts any plugin:
function logPlugin<P extends Plugin>(plugin: P) { // ❌ Error!
  // Generic type 'Plugin' requires 2 type argument(s)
  console.log(plugin.id);
}
```

TypeScript complains because `Plugin` requires type parameters. You'd have to explicitly provide them:

```typescript
function logPlugin<P extends Plugin<unknown, unknown>>(plugin: P) {
  // Have to explicitly pass unknown, unknown every time!
  console.log(plugin.id);
}
```

## The Solution: Default Generics

This is where the loose generics pattern shines. By providing default values for generic parameters, we make simple uses simple while keeping complex uses possible:

```typescript
// WITH defaults - flexible and easy to use
type Plugin<TConfig = unknown, TMethods = unknown> = {
  id: string;
  config: TConfig;
  methods: TMethods;
}

// Define plugin with a simple pass-through function
function definePlugin<T extends Plugin>(plugin: T): T {
  // Validation, registration, etc.
  return plugin;
}

// Usage is clean - no type gymnastics needed!
const myPlugin = definePlugin({
  id: 'analytics',
  config: { apiKey: 'secret' },
  methods: {
    track: (event: string) => console.log(event)
  }
});

// WITHOUT defaults - inflexible and verbose
type StrictPlugin<TConfig, TMethods> = {  // No defaults!
  id: string;
  config: TConfig;
  methods: TMethods;
}

// Now definePlugin needs to pass explicit types
function defineStrictPlugin<T extends StrictPlugin<unknown, unknown>>(
  plugin: T
): T {
  // Have to specify unknown, unknown
  return plugin;
}

// Even worse - every function needs explicit type arguments:
function registerAnyStrictPlugin(
  plugin: StrictPlugin<unknown, unknown>  // Must specify both unknowns!
) {
  console.log(plugin.id);
}

// Compare to the version with defaults:
function registerAnyPlugin(plugin: Plugin) {  // So much cleaner!
  console.log(plugin.id);
}
```

## The Problem Gets Worse with Constraints

The examples above were simple - the generics could be anything. But what happens when your generics have constraints? This is where the lack of defaults becomes truly painful.

### With Constrained Generics

Let's say we have a `Config` type with its own generics, and our `Plugin` requires its config to extend this base `Config`:

```typescript
// Config has its own generics
type Config<TData, TMeta> = {
  baseUrl: string;
  data: TData;
  metadata: TMeta;
}

// Plugin's TConfig must extend Config
type StrictPlugin<TConfig extends Config<any, any>, TMethods> = {
  id: string;
  config: TConfig;
  methods: TMethods;
}
```

Now look at the nightmare of using this without defaults:

```typescript
// WITHOUT DEFAULTS - Nested generic hell
function registerStrictPlugin(
  plugin: StrictPlugin<Config<unknown, unknown>, unknown>
  //                    ^^^^^^^^^^^^^^^^^^^^^^^
  //                    Have to specify Config's generics too!
) {
  console.log(plugin.id);
}

// It gets even worse with multiple functions:
function validateStrictPlugin<T extends StrictPlugin<Config<unknown, unknown>, unknown>>(
  plugin: T
): T {
  // So much nesting!
  return plugin;
}

// And if you want to be more specific about Config:
function processDataPlugin(
  plugin: StrictPlugin<Config<string, { version: number }>, unknown>
  //                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  //                    The verbosity multiplies!
) {
  console.log(plugin.config.baseUrl);
}
```

### The Clean Version with Defaults

Now let's add defaults and see the difference:

```typescript
// Config WITH defaults
type Config<TData = unknown, TMeta = unknown> = {
  baseUrl: string;
  data: TData;
  metadata: TMeta;
}

// Plugin WITH defaults - notice Config gets its defaults too
type Plugin<TConfig extends Config = Config, TMethods = unknown> = {
  id: string;
  config: TConfig;
  methods: TMethods;
}

// WITH DEFAULTS - Everything is clean
function registerPlugin(plugin: Plugin) {
  // Just Plugin! No nested generics!
  console.log(plugin.id);
}

function validatePlugin<T extends Plugin>(plugin: T): T {
  // Simple and readable
  return plugin;
}

function processDataPlugin(
  plugin: Plugin<Config<string, { version: number }>>
  //             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  //             Only specify when you need to!
) {
  console.log(plugin.config.baseUrl);
}
```

The difference is dramatic. Without defaults, every single usage requires spelling out the full generic hierarchy: `Plugin<Config<unknown, unknown>, unknown>`. With defaults, simple cases stay simple (`Plugin`) while complex cases remain possible.

## Real-World Example: TanStack Query

TanStack Query uses this pattern extensively. Look at their query options type:

```typescript
// Simplified version of TanStack Query's approach
type QueryOptions<
  TData = unknown,
  TError = unknown,
  TVariables = void,
  TContext = unknown
> = {
  queryKey: unknown[];
  queryFn: (context: TContext) => Promise<TData>;
  // ... more options
}

// This enables users to write:
function prefetchQuery(options: QueryOptions) {
  // Can accept any query without knowing its specific types
}

// While still allowing specific types when needed:
const userQuery: QueryOptions<User, Error> = {
  queryKey: ['user'],
  queryFn: async () => fetchUser(),
}
```

Without the defaults, every function that accepts query options would need to specify all four generic parameters, making the library much harder to use.

## Best Practices for Library Authors

When designing a library with this pattern:

### 1. Always Provide Defaults
```typescript
// Good
type Config<T = unknown> = {
  value: T;
}

// Less flexible
type Config<T> = {
  value: T;
}
```

### 2. Use `unknown` Over `any`
```typescript
// Prefer unknown - it's safer
type Handler<T = unknown> = (data: T) => void;

// Avoid any when possible
type UnsafeHandler<T = any> = (data: T) => void;
```

### 3. Document Why You Have Defaults
Make it clear that the defaults are intentional:

```typescript
/**
 * Plugin type with sensible defaults.
 * @template TConfig - The config type (defaults to unknown for flexibility)
 * @template TMethods - The methods type (defaults to unknown for flexibility)
 *
 * Using defaults allows consumers to use this type without
 * specifying generics for simple cases like `registerPlugin(plugin: Plugin)`
 */
export type Plugin<TConfig = unknown, TMethods = unknown> = {
  // ...
}
```

## Why This Matters

This pattern is the difference between a library that's a joy to use and one that's a type gymnastics nightmare. It enables:

1. **Progressive disclosure**: Simple uses stay simple, complex uses are possible
2. **Flexible composition**: Types can be composed without knowing exact shapes
3. **Better IntelliSense**: Users don't see overwhelming generic signatures
4. **Extensibility**: Third-party code can extend your types easily

## The Lesson

Next time you see `T = unknown` or a base type that's "never used," remember: it's not redundant. It's a carefully designed escape hatch that makes the library more flexible and user-friendly. The looser the constraints at the base, the more freedom you have to build specific, type-safe abstractions on top.

This pattern embodies a core principle of good library design: make simple things simple, and complex things possible. By providing sensible defaults and base constraints, we let users choose their level of type specificity without forcing complexity on those who don't need it.