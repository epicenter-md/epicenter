# Passing Process Handles Across the Tauri FFI Boundary
For when you want to execute a process in Rust -> hand it off in the Typescript layer

I was building process execution features in Whispering and hit an interesting constraint. I needed to spawn FFmpeg processes from Rust and control them from TypeScript. Simple enough, right? Just spawn the process in Rust and return the handle.

Except you can't. The Tauri invoke boundary is an FFI (Foreign Function Interface) boundary, which means it only supports JSON-serializable data. A process handle isn't JSON-serializable. It contains OS-level resources like file descriptors, handles to kernel objects, internal state pointers. None of that can be turned into JSON and sent across the wire.

This constraint shapes how you design command execution in Tauri. You have two patterns, depending on whether you're spawning a process you need to control, or executing a command and waiting for its result.

## Pattern 1: Spawn and return the PID (don't wait for completion)

When you spawn a process and DON'T wait for it to complete (like FFmpeg recording audio), you need the PID immediately so you can control the process later from TypeScript: kill it, write to stdin, read from stdout/stderr.

The key here is that `spawn()` returns immediately with the process ID. You're not waiting for the process to finish.

The solution: return just the process ID from Rust, then wrap it in a Child object on the TypeScript side.

Here's what the Rust side looks like:

```rust
#[tauri::command]
pub async fn spawn_command(command: String) -> Result<u32, String> {
    let (program, args) = parse_command(&command);

    let mut cmd = Command::new(&program);
    cmd.args(&args);

    match cmd.spawn() {
        Ok(child) => Ok(child.id()), // Just return the PID
        Err(e) => Err(format!("Failed to spawn: {}", e)),
    }
}
```

Notice we're using `spawn()`, which returns immediately without waiting. We extract the PID and return it as `u32`. The process keeps running in the background.

On the TypeScript side, you use the Tauri shell plugin's Child constructor to wrap that PID:

```typescript
const pid = await invoke<number>('spawn_command', { command });
const { Child } = await import('@tauri-apps/plugin-shell');
return new Child(pid);
```

Now you have a Child object that can control the process: `child.kill()`, `child.write()`, event listeners for stdout/stderr. The Child wrapper makes syscalls under the hood using the PID you passed in.

This works because the Child class is designed to work cross-platform with just a PID. It doesn't need the original Rust process handle.

## Pattern 2: Execute and return output (wait for completion)

When you execute a command and DO wait for it to complete (like checking FFmpeg version), you don't need a process handle at all. You're not spawning anything to track or control. You just want the result: exit code, stdout, stderr.

The key here is that `output()` waits for the process to complete before returning. This is a blocking operation.

For this case, define a serializable struct in Rust that matches what TypeScript expects:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[tauri::command]
pub async fn execute_command(command: String) -> Result<CommandOutput, String> {
    let (program, args) = parse_command(&command);

    let mut cmd = Command::new(&program);
    cmd.args(&args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    match cmd.output() {  // This waits for the process to complete
        Ok(output) => Ok(CommandOutput {
            code: output.status.code(),
            signal: None,
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        }),
        Err(e) => Err(format!("Failed: {}", e)),
    }
}
```

Notice we're using `output()`, which blocks until the process completes. By the time this function returns, the process is already done. No need for a handle, no need to track it, no PID to return.

The `#[serde(rename_all = "camelCase")]` attribute ensures field names match TypeScript conventions. `code` stays `code`, but if you had `exit_code`, it would become `exitCode`.

On the TypeScript side, you get the complete output directly:

```typescript
const output = await invoke<ChildProcess<string>>('execute_command', { command });

// The process already completed. You just have the output data.
if (output.code === 0) {
    console.log(output.stdout);
} else {
    console.error(output.stderr);
}
```

This pattern is simpler because you're just passing data. No process handle to reconstruct, no tracking, no lifecycle management.

## When to use each pattern

Use Pattern 1 (spawn, return PID) when the process needs to keep running and you need to control it from TypeScript. FFmpeg recording sessions, development servers, background workers. You call `spawn()` in Rust and it returns immediately with the PID.

Use Pattern 2 (execute, return output) when you just want the result and don't need to interact with the process while it's running. Version checks, one-off transformations, quick utilities. You call `output()` in Rust and it waits until the process completes.

The key insight: these are fundamentally different operations. `spawn()` vs `output()`. One returns immediately with a handle, the other waits and returns data. The FFI boundary just makes that distinction explicit by forcing you to choose what to send back: a PID for tracking, or the final output data.
