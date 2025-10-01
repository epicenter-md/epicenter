# Graceful Error Handling with tryAsync

I was refactoring our FFmpeg recorder service and hit an interesting pattern. We had process cleanup code that would try to kill an FFmpeg child process, but sometimes it would fail - maybe the process was already dead, maybe we lacked permissions, maybe the PID was invalid. The traditional try-catch felt wrong here.

```typescript
try {
  await child.kill();
  console.log(`Killed process ${pid}`);
} catch (e) {
  // Could be already dead, could be permission denied, could be invalid PID
  console.error('Failed to kill process:', e);
  // But should we really throw here? The cleanup needs to continue...
```

## The tryAsync Pattern

This is where wellcrafted's `tryAsync` shines. It lets you handle errors gracefully - whether they're "not really errors" or genuine failures you need to work around:

```typescript
await tryAsync({
  try: async () => {
    const child = new Child(session.pid);
    await child.kill();
    console.log(`Killed FFmpeg process (PID: ${session.pid})`);
  },
  catch: (e) => {
    console.log(`Error terminating FFmpeg process (PID: ${session.pid}): ${extractErrorMessage(e)}`);
    return Ok(undefined);
  },
});
```

Notice how the catch block returns `Ok(undefined)`. We're not saying the error didn't happen - we're saying we can continue despite it. Maybe the process was already dead (great!). Maybe we don't have permissions (oh well, we tried). The cleanup continues either way.

## Why Not Just Use Try-Catch?

You could achieve the same thing with traditional try-catch:

```typescript
try {
  await child.kill();
} catch (e) {
  // Just continue, error doesn't matter
}
```

But the tryAsync pattern with `Ok(undefined)` has key advantages:

1. **Explicit Intent**: `return Ok(undefined)` clearly states "I'm choosing to continue"
2. **Type Safety**: The Result type propagates through your codebase
3. **Consistency**: Fits naturally with other Result-based error handling
4. **Self-Documenting**: The code explains the decision, not just the action

**Sometimes the "error" means you already have what you want:**
- Deleting a file that doesn't exist? Goal achieved.
- Killing a process that's already dead? Goal achieved.

**Sometimes it's a genuine error, but you need to continue anyway:**
- Can't kill a process due to permissions? Log it and move on.
- Can't delete a temp file? Not worth failing the whole operation.

With `Ok(undefined)`, you're making these decisions visible in the type system.

## When Return Types Matter

The pattern gets more interesting when functions return values. Say you're reading a config file with a fallback:

```typescript
const { data: config } = await tryAsync({
  try: () => readFile('config.json'),
  catch: (e) => {
    console.log('No config file, using defaults');
    return Ok({ theme: 'dark', autoSave: true });
  },
});
```

The catch block returns `Ok` with the same type as the try block. Type safety preserved. No null checks needed later.

## When to Actually Propagate Errors

Not every error should be swallowed. Critical failures need to bubble up:

```typescript
const { data, error } = await tryAsync({
  try: () => database.connect(),
  catch: (error) =>
    DatabaseErr({
      message: 'Failed to connect to database',
      cause: error,
    }),
});

if (error) return Err(error);
```

Here we use a custom error constructor that returns `Err`. This propagates the error up the call stack with proper context.

## The Async Initialization Gotcha

One place where tryAsync doesn't work is in synchronous initialization code:

```typescript
// Can't await at module level
if (sessionState.value) {
  // Can't await here either
  clearSession().catch((e) => {
    console.error('Failed to clear orphaned session:', e);
  });
}
```

For fire-and-forget operations during initialization, traditional `.catch()` is still the way to go.

## Rules I've Learned

After refactoring several services to this pattern, here's what works:

1. **Always await tryAsync**. Unlike try-catch, it returns a Promise.
2. **Match return types**. If try returns `string`, catch should return `Ok<string>`.
3. **Use Ok(undefined) for void functions**. It explicitly marks the operation as acceptable despite the error.
4. **Custom error constructors should return Err**. This maintains the Result chain when you need to propagate.

## The Real Benefit

The biggest win isn't the type safety or the explicit error handling. It's that the code now clearly communicates your intent.

When I read:

```typescript
return Ok(undefined); // Error occurred but we're continuing anyway
```

I immediately understand the decision. This isn't silent error suppression. It's an explicit choice: "Yes, something went wrong, but for this operation, that's acceptable."

The lesson: You could swallow errors with empty catch blocks, but that hides your intent. The tryAsync pattern with `Ok(undefined)` makes your decision explicit and type-safe. It's the difference between code that works and code that explains why it works.

And in production systems, that clarity is invaluable.