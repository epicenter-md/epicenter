# PostgreSQL Daemon Architecture: A Study in Process Isolation

PostgreSQL is often cited as the gold standard for relational database reliability. While much of this reputation comes from its strict adherence to ACID properties, its fundamental architectural design, specifically its process-based daemon model, is what makes it remarkably resilient to the types of failures that often take down other systems.

In an era where many high-performance systems default to thread-per-connection models for lower overhead, PostgreSQL remains a process-per-connection system. This decision isn't a relic of the past; it is a deliberate choice for isolation and crash safety.

## The Postmaster: The Orchestrator

The heart of a PostgreSQL cluster is the "Postmaster" process. When you run the `postgres` command, it initializes the system and enters a loop where it listens for incoming connections on a TCP port (typically 5432) or a Unix-domain socket.

The Postmaster is the parent of all other processes in the cluster. Its responsibilities include:

1.  **Bootstrap**: Initializing shared memory segments and semaphores that allow various processes to communicate and synchronize access to the buffer cache.
2.  **Connection Handling**: When a new client connects, the Postmaster performs a `fork()` to create a new "backend" process dedicated to that connection.
3.  **Process Management**: It monitors all its child processes. If a background worker or a backend crashes, the Postmaster is responsible for the cleanup, which often involves a "graceful restart" of the entire cluster to ensure shared memory hasn't been corrupted.

## The Process Tree

If you run `ps -ef --forest` on a machine running PostgreSQL, you will see a structure similar to this:

```text
postgres (Postmaster)
├── postgres: checkpointer
├── postgres: background writer
├── postgres: walwriter
├── postgres: autovacuum launcher
├── postgres: logical replication launcher
├── postgres: user_db user_name [local] idle
└── postgres: user_db user_name 127.0.0.1(54321) idle
```

Every connection gets its own `postgres` process. This provides absolute memory isolation. A memory leak or a segmentation fault in one backend process cannot directly corrupt the memory of another backend or the main Postmaster.

## Shared Memory and IPC

Since every backend is a separate process, they cannot share data through simple pointers. Instead, PostgreSQL uses System V or POSIX shared memory. This shared memory contains:

- **Buffer Cache**: The shared pool of data blocks read from disk.
- **Lock Table**: Synchronization primitives to manage concurrent access to rows and tables.
- **WAL Buffers**: The Write-Ahead Log records before they are flushed to disk.

Semaphores and spinlocks are used to coordinate access to these shared structures, ensuring that two backends don't attempt to modify the same buffer simultaneously.

## The Background Chorus

While backends handle client queries, a set of background worker processes handles the "housekeeping" of the database:

- **Checkpointer**: Periodically flushes all dirty buffers to disk, creating a "checkpoint" that limits the amount of WAL that needs to be replayed during crash recovery.
- **Background Writer**: Continuously writes dirty buffers to disk in small batches to ensure that backends always find "clean" (available) buffers when they need to read data.
- **WAL Writer**: Flushes Write-Ahead Log records from the shared buffer to persistent storage. This ensures that committed transactions are durable even if the system loses power.
- **Autovacuum Launcher**: Coordinates "vacuum" operations that reclaim space used by dead tuples (deleted or updated rows), preventing table bloat.
- **Stats Collector**: Historically a separate process, but as of PostgreSQL 15, statistics collection has been moved into shared memory for better performance and reduced overhead.

## Discovery and Control

PostgreSQL uses a simple but effective pattern for discovery: the `postmaster.pid` file located in the data directory (`PGDATA`). This file contains the PID of the Postmaster, the port it is listening on, and the path to the Unix socket.

Tools like `pg_ctl` use this file to send signals to the Postmaster. PostgreSQL implements three distinct shutdown modes via signals:

1.  **Smart Shutdown (SIGTERM)**: Disallows new connections but waits for existing backends to finish their work and disconnect.
2.  **Fast Shutdown (SIGINT)**: The most common choice. It sends a SIGTERM to all backends, rolls back active transactions, and shuts down as soon as they exit.
3.  **Immediate Shutdown (SIGQUIT)**: The Postmaster sends SIGQUIT to all backends and exits immediately. This is equivalent to a power failure; upon next start, the database will perform crash recovery by replaying the WAL.

## Lessons for Systems Developers

The PostgreSQL architecture teaches us that **isolation is a feature**. While threads are cheaper to create, processes provide a "hard" boundary that simplifies debugging and prevents cascading failures.

By leveraging the Unix `fork()` model, Postgres inherits a copy-on-write view of the initial environment and memory, making the startup of new backends remarkably efficient despite the process overhead. For developers building distributed systems or local-first tools, the pattern of a stable "orchestrator" managing ephemeral "workers" remains one of the most robust ways to build software that simply doesn't crash.
