# Simplify Markdown Index Function Signatures

## Problem

The `MarkdownIndexConfig` type defines several optional fields:
- `tableAndIdToPath?: (params) => string`
- `serializers?: {...}`

However, by the time we call internal functions like `registerYJSObservers` and `registerFileWatcher`, these optional fields have been given default values in the `markdownIndex` function:

```typescript
export function markdownIndex({
  // ...
  tableAndIdToPath = defaultTableAndIdToPath,  // ← default applied here
  serializers = {},                             // ← default applied here
}: IndexContext<TSchema> & MarkdownIndexConfig<TSchema>) {
  // ...

  // But the function signature still references the optional type
  const unsubscribers = registerYJSObservers({
    tableAndIdToPath,  // ← no longer optional, but type says it is
    serializers,        // ← no longer optional, but type says it is
  });
}
```

The current signatures for these functions are:
```typescript
function registerYJSObservers({
  tableAndIdToPath,
  serializers,
}: {
  tableAndIdToPath: MarkdownIndexConfig<TSchema>['tableAndIdToPath'];  // ← still optional
  serializers: MarkdownIndexConfig<TSchema>['serializers'];             // ← still optional
}): Array<() => void>
```

This is misleading because:
1. The types suggest these parameters might be `undefined`
2. But they're never actually `undefined` at runtime
3. The function implementations don't handle `undefined` cases
4. TypeScript forces unnecessary optional chaining or type assertions

## Solution

Create explicit, non-optional types for these internal functions that better represent the runtime reality that defaults have been applied.

## Todo

- [x] Create explicit types for required parameters
- [x] Update `registerYJSObservers` signature
- [x] Update `registerFileWatcher` signature
- [x] Verify no type errors

## Implementation

### Step 1: Create explicit types

Instead of referencing `MarkdownIndexConfig<TSchema>['tableAndIdToPath']`, create explicit non-optional types:

```typescript
type TableAndIdToPath = (params: { id: string; tableName: string }) => string;
type PathToTableAndId = (params: { path: string }) => Result<{ tableName: string; id: string }, MarkdownIndexError>;
type Serializers<TSchema extends WorkspaceSchema> = {
  [K in keyof TSchema]?: MarkdownSerializer<TSchema[K]>;
};
```

### Step 2: Update function signatures

Update both internal functions to use these explicit types:

```typescript
function registerYJSObservers<TSchema extends WorkspaceSchema>({
  db,
  rootPath,
  tableAndIdToPath,
  serializers,
  syncCoordination,
}: {
  db: Db<TSchema>;
  rootPath: AbsolutePath;
  tableAndIdToPath: TableAndIdToPath;  // ← now required
  serializers: Serializers<TSchema>;    // ← now required (but can be empty object)
  syncCoordination: SyncCoordination;
}): Array<() => void>
```

```typescript
function registerFileWatcher<TSchema extends WorkspaceSchema>({
  db,
  rootPath,
  pathToTableAndId,
  serializers,
  syncCoordination,
}: {
  db: Db<TSchema>;
  rootPath: AbsolutePath;
  pathToTableAndId: PathToTableAndId;  // ← now required
  serializers: Serializers<TSchema>;   // ← now required (but can be empty object)
  syncCoordination: SyncCoordination;
}): FSWatcher
```

## Benefits

1. **Type accuracy**: Types now reflect runtime reality
2. **Simpler code**: No need for optional chaining or type assertions
3. **Better documentation**: Function signatures clearly show these are required
4. **Cascading clarity**: The pattern of "defaults applied at boundary" is now visible in types

## Review

### Changes Made

Successfully simplified the markdown index function signatures by introducing explicit, reusable types that better represent runtime reality.

**1. Created three reusable types** (packages/epicenter/src/indexes/markdown/index.ts:72-78):
```typescript
type TableAndIdToPath = (params: { id: string; tableName: string }) => string;
type PathToTableAndId = (params: { path: string }) => Result<{ tableName: string; id: string }, MarkdownIndexError>;
type Serializers<TSchema extends WorkspaceSchema> = {
  [K in keyof TSchema]?: MarkdownSerializer<TSchema[K]>;
};
```

**2. Updated MarkdownIndexConfig** to use these types:
- Line 149: `pathToTableAndId?: PathToTableAndId;`
- Line 174: `tableAndIdToPath?: TableAndIdToPath;`
- Line 206: `serializers?: Serializers<TWorkspaceSchema>;`

**3. Updated internal function signatures**:
- `registerYJSObservers` (line 796-797): Now uses `TableAndIdToPath` and `Serializers<TSchema>` (non-optional)
- `registerFileWatcher` (line 938-939): Now uses `PathToTableAndId` and `Serializers<TSchema>` (non-optional)

### Benefits Achieved

1. **Type Accuracy**: The type system now accurately reflects that by the time parameters reach internal functions, default values have been applied and they're no longer optional.

2. **DRY Principle**: Type definitions are no longer duplicated. The same type is used in both the config interface and internal functions.

3. **Better Documentation**: Function signatures clearly communicate that these parameters are required, eliminating confusion about whether they might be undefined.

4. **Cascading Clarity**: The pattern of "defaults applied at boundary" is now visible in the type system itself.

### Testing

Ran `bun test` to verify no TypeScript compilation errors were introduced. The tests confirmed that the type changes are valid and don't break any existing code.
