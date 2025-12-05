# Generic Drilling in TypeScript: The Hidden Cost of Type Extraction

Here's something I never consciously noticed until recently: every TypeScript type is like a top-level function. You can't define a type inside another type's "closure" and have it automatically inherit context.

This creates the exact same problem as React components. In React, you can't define a component inside another component and expect it to automatically inherit props. Every component must explicitly declare its props, even if those props just get passed down from a parent.

```jsx
// React: Child components can't be defined in Parent to inherit parent props
function BlogPost({ title, author, tags, publishedAt }) {
  // If we extract this, it needs explicit props
  return <PostHeader title={title} author={author} />; // Must pass explicitly
}

function PostHeader({ title, author }) { // Must declare what it needs
  return <h1>{title} by {author}</h1>;
}
```

TypeScript has the same limitation with types:

```typescript
// TypeScript: Helper types can't inherit parent generics
type Plugin<TId, TTableMap, TMethodMap, TDeps> = {
  // If we extract this, it needs explicit generics
  methods: (api: BuildNamespace<TId, TTableMap>) => TMethodMap; // Must pass explicitly
}

type BuildNamespace<TId, TTableMap> { // Must declare what it needs
  // implementation
}
```

This is generic drilling. And once you see it, you can't unsee it.

## Why This Matters

Let me show you a concrete example. I was working on a plugin system when I hit this type:

```typescript
type BuildInitialPluginNamespace<TId, TTableMap> = {
  // ...implementation
}
```

Look at those generics: `TId` and `TTableMap`. The name suggests it's just about building a namespace, but it needs to know about the plugin's ID and table structure. Why?

Because it's extracted from this larger type:

```typescript
type Plugin<TId, TTableMap, TMethodMap, TDeps> = {
  id: TId;
  tables: TTableMap;
  methods: (
    api: BuildDependencyNamespaces<TDeps> &
      BuildInitialPluginNamespace<TId, TTableMap>, // Must drill generics
  ) => TMethodMap;
}
```

Even though `BuildInitialPluginNamespace` is used inside `Plugin`, it can't automatically access `TId` and `TTableMap`. They have to be explicitly passed down, just like React props.

This is exactly like having a React component with 4 props, then extracting a child component that only uses 2 of them. The child component still has to explicitly declare those 2 props in its signature, even though they're "available" in the parent.

## The JavaScript vs TypeScript Difference

```javascript
function createPlugin(id, tables) {
  // Inner functions automatically access outer scope
  function buildNamespace() {
    return { [id]: tables }; // id and tables are available
  }

  return buildNamespace();
}
```

But in TypeScript's type system, this doesn't exist. There's no equivalent to closures for types. Every type stands alone, which means context must be explicitly passed down through generic parameters.

## Real Examples of Generic Drilling

Let's look at some common patterns where this bites you:

**API Response Types:**
```typescript
// You have an API response with user info
type ApiResponse<TUser, TMetadata> = {
  data: TUser;
  metadata: TMetadata;
  // ... other fields
}

// You want a helper to extract just the user data
type ExtractUser<TUser, TMetadata> = ApiResponse<TUser, TMetadata>['data'];
//                 ^^^^^ ^^^^^^^^^
// Why does extracting user data need to know about metadata?
// Because the helper type can't "see" the original generics
```

**Form Validation:**
```typescript
// A form with validation rules
type FormConfig<TFields, TValidation> = {
  fields: TFields;
  validation: TValidation;
}

// Helper to get field names
type FieldNames<TFields, TValidation> = keyof TFields;
//              ^^^^^^^^ ^^^^^^^^^^^
// Getting field names shouldn't need validation info,
// but the helper type must receive both generics
```

**Database Queries:**
```typescript
// A query builder with table and column info
type QueryBuilder<TTable, TColumns> = {
  table: TTable;
  columns: TColumns;
  // ... query methods
}

// Helper to build WHERE clauses
type WhereClause<TTable, TColumns> = {
//               ^^^^^^ ^^^^^^^^
// WHERE clauses only care about columns,
// but we have to pass the table type too
  [K in keyof TColumns]: // ... condition logic
}
```

This is the pattern. Helper types end up needing context they don't conceptually use, just because TypeScript can't automatically inherit it.

## A Clearer Comparison: Function Scope vs Generic Scope

Let me show you exactly what I mean with a side-by-side comparison.

In JavaScript, when you extract logic, inner scope is maintained:

```javascript
// JavaScript: Inner functions capture outer scope
function createBlogSystem(userId, permissions) {
  // Helper functions automatically have access to userId and permissions
  const validateUser = () => {
    return permissions.includes('write'); // No parameter passing needed
  };

  const createPost = (title, content) => {
    if (!validateUser()) throw new Error('No permission');
    return { id: generateId(), title, content, author: userId };
  };

  const deletePost = (postId) => {
    if (!validateUser()) throw new Error('No permission');
    // Use userId directly
    return database.delete(postId, userId);
  };

  return { createPost, deletePost };
}
```

But in TypeScript types, you can't do this. Each type is isolated:

```typescript
// TypeScript: Each type stands alone, requiring explicit context
type CreateBlogSystem<TUserId, TPermissions> = {
  createPost: CreatePost<TUserId, TPermissions>; // Must pass both
  deletePost: DeletePost<TUserId, TPermissions>; // Must pass both
}

// Each helper type needs explicit generics
type CreatePost<TUserId, TPermissions> = (
  title: string,
  content: string
) => Post<TUserId>;

type DeletePost<TUserId, TPermissions> = (
  postId: string
) => boolean;

// Even validation needs explicit context
type ValidateUser<TPermissions> = () => boolean;
```

Notice how every helper type must explicitly receive the generics it needs? That's generic drilling.

## Why This Happens: TypeScript's Design (Maybe delete this)
This is a fundamental consequence of how TypeScript's type system works:

**1. Types are compile-time constructs**
Types don't exist at runtime, so they can't capture runtime context like closures do.

**2. Structural typing**
TypeScript cares about the shape of types, not where they're defined. Each type must be complete and self-contained.

**3. No lexical scoping for types**
Unlike functions, types don't have access to surrounding scope. Generic parameters are the only way to pass context.

**4. Global type namespace**
All types live in a global namespace (per module). There's no concept of nested type scope.

## The Real Cost

As your type hierarchy grows, this pattern becomes painful:

**Verbose signatures everywhere:**
```typescript
// Look at all that drilling
type PluginNamespace<TId, TTableMap, TMethodMap, TDeps> =
  BuildDependencies<TDeps> &
  BuildTables<TId, TTableMap> &
  BuildMethods<TId, TTableMap, TMethodMap>;
```

**Refactoring nightmares:**
Change one generic? Now you have to update every type in the chain.

**Cognitive overhead:**
Developers spend mental energy tracking which generics go where instead of focusing on business logic.

**Documentation burden:**
Each helper type needs to explain why it needs all those generics.

**Type error cascades:**
One missing generic creates a chain of confusing error messages.

## Patterns That Help

### 1. Bundle Related Generics

Instead of drilling individual generics, bundle them:

```typescript
// Before: Multiple individual generics
type BuildNamespace<TId, TTableMap, TMethodMap> = {
  // implementation
}

// After: Bundled context
type PluginContext<TId, TTableMap, TMethodMap> = {
  id: TId;
  tables: TTableMap;
  methods: TMethodMap;
}

type BuildNamespace<TContext extends PluginContext<any, any, any>> = {
  // implementation using TContext['id'], TContext['tables'], etc.
}
```

### 2. Strategic Inlining

Sometimes the "helper" type isn't worth extracting:

```typescript
// Instead of extracting every little type...
type BuildInitialPluginNamespace<TId, TTableMap> = {
  [K in TId]: TableNamespaceForPlugin<TTableMap>
};

type TableNamespaceForPlugin<TTableMap> = {
  [TableName in keyof TTableMap]: TableHelpers<TTableMap[TableName]>
};

// Just inline the simple ones:
type BuildInitialPluginNamespace<TId, TTableMap> = {
  [K in TId]: {
    [TableName in keyof TTableMap]: TableHelpers<TTableMap[TableName]>
  }
};
```

### 3. Accept the Drilling

Sometimes generic drilling is the clearest solution. Don't fight it; embrace it with good naming:

```typescript
// Clear names make drilling intentions obvious
type BuildPluginAPI<
  TPluginId extends string,
  TPluginTables extends PluginTableMap,
  TDependencyPlugins extends readonly Plugin[]
> =
  BuildDependencyNamespaces<TDependencyPlugins> &
  BuildOwnNamespace<TPluginId, TPluginTables>;
```

## The Lesson

Not every data access needs a service. Not every helper type needs extraction.

TypeScript's generic drilling isn't a limitation to work around. It's a design trade-off that makes the type system predictable and powerful. The explicit parameter passing that feels verbose actually provides clarity: you can see exactly what context each type needs.

The key is recognizing when you're drilling generics unnecessarily. Ask yourself:

- Is this helper type complex enough to warrant extraction?
- Am I passing more than 3-4 generics to a helper type?
- Would inlining this type make the code clearer?

Sometimes the best type is the one you don't write.

## What This Taught Me

Every TypeScript developer eventually discovers that types aren't just "documentation that the compiler checks." They're a parallel programming language with their own patterns, pain points, and architectural considerations.

Generic drilling is one of those patterns. Once you see it, you can't unsee it. And that's a good thing; it makes you a more thoughtful type architect.

The next time you find yourself passing four generics to a "simple" helper type, remember: you're not just writing types. You're designing the interface between human understanding and machine verification. Sometimes that interface needs to be explicit, even when it feels verbose.

That's not a bug. That's TypeScript working as intended.