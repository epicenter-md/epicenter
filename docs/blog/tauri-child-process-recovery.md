# Tauri's Hidden Gem: Recovering Child Processes After Page Refresh

I was building a desktop app with Tauri that needed to spawn FFmpeg processes for audio recording. Simple enough, right? Spawn a process, keep the reference, kill it when done. But then I hit a wall: what happens when the webview refreshes?

Here's the thing that took me too long to realize: when your frontend refreshes (hot reload during development, or a user-triggered refresh), all your JavaScript variables disappear. Including that `Child` process reference you were holding onto. The FFmpeg process keeps running in the background, but you've lost your handle to it. Now you have an orphaned process, potentially recording audio forever, filling up disk space.

## The Rust Singleton Rabbit Hole

My first instinct was to move all the process management into Rust. Build a proper singleton, maintain a `HashMap<String, Child>` of all processes, expose commands to start/stop/query them. Something like:

```rust
// I was about to write all this...
struct ProcessManager {
    processes: Mutex<HashMap<String, Child>>
}

#[tauri::command]
fn spawn_process(id: String, command: String, state: State<ProcessManager>) -> Result<()> {
    // Spawn and store in HashMap
}

#[tauri::command]
fn kill_process(id: String, state: State<ProcessManager>) -> Result<()> {
    // Look up and kill
}
```

This would mean shuttling process IDs back and forth between JavaScript and Rust, adding complexity to both layers. I'd need to carefully manage the lifecycle, handle cleanup, worry about memory leaks. It felt like overkill for what should be a simple problem.

Thankfully, I didn't need any of this. Tauri already provides a clean primitive - I just didn't know it existed.

## The Problem: Child Processes Don't Serialize

Before discovering the solution, I tried the obvious approach: throw the `Child` object into localStorage:

```typescript
// This doesn't work!
const child = await Command.create('ffmpeg', args).spawn();
localStorage.setItem('currentProcess', JSON.stringify(child)); // Nope!
```

A `Child` object is complex - it has methods, event emitters, internal state. You can't just serialize it to JSON. So I started going down a rabbit hole: maybe I could use raw shell commands to find and kill processes? Parse `ps aux` output? Platform-specific kill commands?

## The Discovery: PIDs Are All You Need

Then I found it, buried in Tauri's shell plugin source code. The `Child` class has a constructor that takes just a PID:

```typescript
// From @tauri-apps/plugin-shell
class Child {
  constructor(pid: number) {
    this.pid = pid;
  }
  
  async kill(): Promise<void> {
    // Tauri handles the rest!
  }
}
```

That's it. No complex state restoration. No Rust singleton needed. Just pass a PID, and Tauri rebuilds the entire child process wrapper.

## The Lifecycle Visualized

Here's how the Child → PID → Child transformation works across page refreshes:

```
BEFORE REFRESH:
┌─────────────────────────────────────┐
│  JavaScript Memory                  │
│                                     │
│  child = Command.spawn()            │
│    ├─ pid: 12345                   │
│    ├─ kill()                       │
│    └─ write()                      │
└─────────────────────────────────────┘
                ↓
         Store just the PID
                ↓
┌─────────────────────────────────────┐
│  localStorage                       │
│  { "pid": 12345 }                   │
└─────────────────────────────────────┘

PAGE REFRESH 🔄

AFTER REFRESH:
┌─────────────────────────────────────┐
│  localStorage                       │
│  { "pid": 12345 }                   │
└─────────────────────────────────────┘
                ↓
          Read the PID
                ↓
┌─────────────────────────────────────┐
│  JavaScript Memory                  │
│                                     │
│  child = new Child(12345)           │
│    ├─ pid: 12345                   │
│    ├─ kill()  ✓                    │
│    └─ write() ✓                    │
└─────────────────────────────────────┘
```

The key insight:
- **Before refresh**: Full `Child` object with all methods
- **During refresh**: Only the PID survives (just a number!)
- **After refresh**: Reconstruct full `Child` from PID
- **Same capabilities**: The reconstructed `Child` can kill, write, and manage the process just like the original

## The Solution: PID-Based Recovery

Here's how I refactored my FFmpeg recorder to survive page refreshes:

```typescript
import { Child } from '@tauri-apps/plugin-shell';
import { createPersistedState } from '@repo/svelte-utils';

// Store only the PID and metadata
const sessionState = createPersistedState({
  key: 'ffmpeg-session',
  schema: {
    pid: 'number | null',
    outputPath: 'string | null',
    startedAt: 'number | null'
  }
});

// Lazily recreate Child from PID when needed
const getCurrentChild = (): Child | null => {
  const pid = sessionState.value.pid;
  return pid ? new Child(pid) : null;
};
```

If you examine the Tauri source code, you'll notice the `Child` class isn't heavyweight at all. It's essentially just a thin wrapper that holds a PID and provides helper methods like `kill()` and `write()`. There's nothing heavy or resource-intensive about creating these objects, which makes this lazy recovery pattern particularly efficient. The persisted PID acts as your source of truth, and the `Child` instance is simply a functional pipeline that transforms this PID into useful operations. This lightweight nature gives you confidence to lazily create `Child` instances whenever needed without worrying about performance overhead.

When starting a recording:

```typescript
const process = await Command.create('ffmpeg', args).spawn();

// Store just the PID
sessionState.value = {
  pid: process.pid,  // Just a number!
  outputPath: '/path/to/output.wav',
  startedAt: Date.now()
};
```

After a page refresh, I can recover and kill the orphaned process:

```typescript
// On initialization, check for orphaned processes
if (sessionState.value.pid) {
  console.warn(`Found orphaned FFmpeg process: PID ${sessionState.value.pid}`);
  
  // Recreate the Child wrapper
  const orphan = new Child(sessionState.value.pid);
  
  // Kill it just like a normal Child
  await orphan.kill();
  console.log('Cleaned up orphaned process');
}
```

## Why This Works

When you create a `Child` with just a PID, the JavaScript side sends that PID to Rust, which looks it up. All the platform-specific process management stays in Rust. Your JavaScript just needs to remember a number.

The `kill()` method works identically whether you have the original `Child` reference or a reconstructed one:

```typescript
// Original reference
const child = await Command.create('my-app').spawn();
await child.kill();

// Reconstructed from PID
const reconstructed = new Child(child.pid);
await reconstructed.kill();  // Identical behavior!
```

## The Pattern for Production

Here's the pattern I settled on for production apps:

1. **Never store Child references directly** - They're lost on refresh
2. **Always persist PIDs** - Simple numbers that survive refreshes
3. **Lazily reconstruct** - Create `Child` instances from PIDs only when needed
4. **Check on startup** - Look for orphaned processes and clean them up

```typescript
function createProcessManager() {
  const session = createPersistedState({ 
    key: 'process-session',
    schema: { pid: 'number | null' }
  });
  
  // Check for orphans on startup
  if (session.value.pid) {
    const orphan = new Child(session.value.pid);
    orphan.kill().catch(() => {
      // Process might already be dead
    });
    session.value = { pid: null };
  }
  
  return {
    async start(command: string, args: string[]) {
      const child = await Command.create(command, args).spawn();
      session.value = { pid: child.pid };
      return child;
    },
    
    async stop() {
      if (session.value.pid) {
        const child = new Child(session.value.pid);
        await child.kill();
        session.value = { pid: null };
      }
    }
  };
}
```

## The Lesson

I almost built an entire Rust-side process management system when Tauri had already solved the problem elegantly. You don't need complex process tracking, Rust singletons, or platform-specific commands. A PID is just a number, and numbers are easy to persist. The `Child` constructor does all the heavy lifting of reconnecting to that process.

Sometimes the best solutions are the ones that are already there, waiting in the constructor you didn't know existed. Before reaching for Rust, check if Tauri's JavaScript API already has what you need. In this case, it was literally just `new Child(pid)`.

## References

- [Tauri Shell Plugin - Child Class](https://v2.tauri.app/reference/javascript/shell/#new-child)
- [Source: @tauri-apps/plugin-shell](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/guest-js/index.ts#L299)