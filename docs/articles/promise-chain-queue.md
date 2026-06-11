# A Serial Async Queue Is Just One Variable

You don't need a class, an array of callbacks, or a drain loop to serialize async work. One variable and promise chaining is enough.

```typescript
let syncQueue = Promise.resolve();
```

Every time a new task arrives, chain it off the current tail:

```typescript
syncQueue = syncQueue.then(task).catch(log);
```

That's the whole pattern. Each `.then()` returns a new promise that waits for the previous one before running. Reassigning `syncQueue` to that new promise means the next task will wait for this one. The chain grows forward automatically.

## Each `.catch()` keeps the queue alive

The `.catch()` placement matters more than it looks. Put it at the end of the whole chain and one failure kills everything after it. A rejected promise propagates forward, so every subsequent `.then()` skips. Put it after each task and errors are isolated. The queue keeps moving.

```typescript
syncQueue = syncQueue
    .then(async () => {
        // async work
    })
    .catch((error) => {
        console.warn('[recording-materializer] write failed:', error);
    });
```

The `.catch()` returns a resolved promise, so the next task in the chain sees a clean slate regardless of what happened before it.

## Where we use this in Whispering

The recording materializer in `apps/whispering/src/lib/client.ts` is a workspace extension that observes the recordings table and writes `.md` files to disk via Rust commands. The observer fires synchronously whenever recordings change, and recordings can change rapidly. Without serialization, concurrent `invoke()` calls would race each other.

```typescript
let syncQueue = Promise.resolve();

unsub = ctx.tables.recordings.observe((changedIds) => {
    syncQueue = syncQueue
        .then(async () => {
            const toWrite: { filename: string; content: string }[] = [];
            const toDelete: string[] = [];

            for (const id of changedIds) {
                const result = ctx.tables.recordings.get(id);
                if (result.status === 'valid') {
                    toWrite.push(toRecordingMarkdownFile(result.row));
                } else if (result.status === 'not_found') {
                    toDelete.push(`${id}.md`);
                }
            }

            if (toWrite.length) {
                await invoke('write_markdown_files', { directory: dir, files: toWrite });
            }
            if (toDelete.length) {
                await invoke('delete_files_in_directory', { directory: dir, filenames: toDelete });
            }
        })
        .catch((error) => {
            console.warn('[recording-materializer] write failed:', error);
        });
});
```

The observer callback is synchronous. It doesn't await anything. It just appends to the chain and returns. The async work happens in the background, one batch at a time, in the order the observer fired.

The `dispose()` method awaits the queue before tearing down, so in-flight writes finish cleanly:

```typescript
async dispose() {
    unsub?.();
    await syncQueue;
},
```

## Why not an array-based queue?

The array approach looks like this: push tasks into an array, track whether a drain loop is running, start the loop if it isn't, pop tasks off the front one at a time. It works, but it's four moving parts instead of one. You have to manage the array, the running flag, the loop, and the error handling separately. The promise chain does all of that implicitly. The chain itself is the queue, the pending promise is the running flag, and `.then()` is the drain loop.

## When this pattern isn't enough

This queue has no cancellation. Once a task is chained, it will run. If you need to cancel in-flight work. Say, because the user navigated away or a newer request supersedes an older one. You need something that tracks individual tasks and can abort them.

It has no backpressure. If tasks arrive faster than they complete, the chain grows without bound. For a recording materializer that fires on user edits, that's fine. For a queue that processes network responses at arbitrary volume, it's a memory leak waiting to happen.

It has no retry. A failed task logs and moves on. If you need exponential backoff or dead-letter handling, you'll want a proper queue library.

For fire-and-forget serial execution where tasks are short-lived and bounded in number, one variable is all you need.
