# The Single-Writer Architecture: Why You Should Stop Sharing Resources

In modern application development, we are conditioned to believe that concurrency is the ultimate goal. We want our databases to handle thousands of simultaneous connections, our services to be stateless and horizontally scalable, and our file systems to be accessed by many processes at once.

However, when you actually get into the weeds of building local-first apps, high-performance databases, or distributed systems, you often find that the most robust solution is the exact opposite: the single-writer pattern.

## The Problem: The Cost of Competition

When multiple writers try to modify the same resource simultaneously, you don't just get speed; you get conflicts.

In the world of SQLite, this manifests as the dreaded `SQLITE_BUSY` error. Even with Write-Ahead Logging (WAL) enabled, SQLite only allows one writer at a time. If two processes attempt to commit a transaction simultaneously, one will fail.

In local-first applications, file system watchers are a common source of pain. If two instances of an app are watching the same directory and writing to it, they can trigger an infinite loop of "file changed" events, leading to CPU spikes and data corruption.

Race conditions are the silent killer here. You read a value, increment it in memory, and write it back. If another process did the same thing between your read and write, one of those increments is lost. To solve this, you need locks, semaphores, or complex consensus algorithms. Or, you can just use a single writer.

## The Pattern: Ownership and Delegation

The single-writer architecture is simple: exactly one process or thread "owns" the resource. All other processes that want to make changes do not write directly. Instead, they proxy their requests to the owner.

The owner handles serialization. It receives requests, puts them in a queue, and processes them one by one.

```text
[ Client A ] ---- (Request) ----+
                                |
[ Client B ] ---- (Request) ----|--> [ SINGLE WRITER ] --> [ DATABASE/FILE ]
                                |      (Queue & Logic)
[ Client C ] ---- (Request) ----+
```

## Real-World Examples

### Redis

Redis is the poster child for this pattern. Despite being one of the fastest data stores in existence, it is primarily single-threaded for its core execution logic. By avoiding the overhead of locks and context switching between threads, it achieves massive throughput with extreme simplicity.

### SQLite

While SQLite allows multiple readers, it is fundamentally a single-writer system at the file level. The most robust way to use SQLite in a multi-process environment (like a desktop app with a CLI and a GUI) is to have one "daemon" process manage the database and provide an IPC interface for others.

### Kafka

In Kafka, partitions are the unit of parallelism. However, for any given partition, there is exactly one leader. All writes to that partition go through that leader, which ensures the strictly ordered log that makes Kafka so reliable.

## Implementation: The Smart Client

How do you implement this without making the user manually start a "server" process? You use the "Smart Client" pattern.

When a client starts, it follows this logic:

1.  **Check for an owner**: Try to connect to a known IPC socket or check for a lock file (PID file).
2.  **If owner exists**: Enter "proxy mode." Send all write commands to the existing process.
3.  **If no owner**: Try to become the owner. Create the lock file and start the write-processing loop.

This is how many high-quality desktop applications handle multiple instances. In Tauri apps, for example, the `single-instance` plugin ensures that if you try to open the app twice, the second instance simply passes its arguments to the first and exits.

## Trade-offs: Simplicity vs. Throughput

The single-writer pattern is not a silver bullet. Its main limitation is the bottleneck of a single CPU core. If your write volume exceeds what one process can handle, you eventually have to shard your data.

However, for 99% of applications. Especially local-first tools and internal services. The bottleneck isn't the CPU; it's the complexity of distributed state.

### Why you want it:

- **No Race Conditions**: Serialization is guaranteed.
- **Predictable Performance**: You don't have to worry about lock contention or "thundering herd" problems.
- **Easier Debugging**: You can follow the execution of every write in a single log stream.

### When to avoid it:

- **Global Scale**: If you need to write to the same record from Tokyo and New York simultaneously with low latency.
- **Massive Throughput**: If you are ingesting millions of events per second that require immediate processing.

## Conclusion

The next time you reach for a complex distributed locking library or start wrapping every database call in a retry loop for concurrency errors, ask yourself: could I just have one process own this?

Simplicity is a feature. By centralizing write access, you eliminate a whole class of bugs and make your system significantly easier to reason about. In the race for performance, sometimes the fastest way to the finish line is to stop competing with yourself.
