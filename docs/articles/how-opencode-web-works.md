# How OpenCode Web Works

When you run `opencode web` and open it in a browser, you're not looking at a chat interface with a terminal-like skin. You're looking at a real terminal. Raw bytes, ANSI escape sequences, cursor positioning. Streamed over WebSocket to a JavaScript terminal emulator running in your browser.

This article explains the architecture.

---

## The Architecture

```
┌─────────────────────────┐      WebSocket      ┌──────────────────────────┐
│  Browser / Desktop App  │◄───────────────────►│  OpenCode Backend        │
│  (SolidJS)              │                     │  (Bun HTTP Server)       │
│                         │                     │                          │
│  ┌───────────────────┐  │      PTY/WS        │  ┌────────────────────┐  │
│  │ ghostty-web       │◄─┼─────────────────────┼─►│ Pseudo Terminal    │  │
│  │ (WASM terminal)   │  │   raw bytes         │  │ (PTY)              │  │
│  └───────────────────┘  │                     │  └────────────────────┘  │
└─────────────────────────┘                     └──────────────────────────┘
```

Three pieces make this work:

1. **OpenCode Backend**: A Bun HTTP server that handles API requests and manages PTY sessions
2. **ghostty-web**: Ghostty's terminal emulator compiled to WebAssembly, running in the browser
3. **WebSocket transport**: Real-time bidirectional communication between browser and PTY

---

## Starting a Server

When you run `opencode` or `opencode web`, a Bun HTTP server starts on your machine:

```typescript
// Port allocation logic
if (opts.port === 0) {
	try {
		return Bun.serve({ ...args, port: 4096 }); // Try default port
	} catch {
		// Port taken, let OS assign one
	}
}
return Bun.serve({ ...args, port: opts.port });
```

The first instance claims port 4096. Every subsequent instance gets a random available port (the OS picks when you pass `port: 0` to Bun.serve). This means you can run as many OpenCode servers as you want, each on a different port.

You can connect any number of clients to each server. Open the same URL in multiple browser tabs. They all connect to the same backend and share state.

---

## The Terminal Connection

When the web app loads, it doesn't just render a fancy chat UI. It creates a real terminal session.

The split terminal at the bottom of OpenCode's interface is a PTY connection over WebSocket. Here's what happens when it mounts:

```typescript
// From packages/desktop/src/components/terminal.tsx
import { Ghostty, Terminal as Term, FitAddon } from "ghostty-web"

onMount(async () => {
  // Load Ghostty's WASM terminal emulator
  ghostty = await Ghostty.load()

  // Connect to the PTY session over WebSocket
  ws = new WebSocket(sdk.url + `/pty/${local.pty.id}/connect?directory=${...}`)

  // Create the terminal instance
  term = new Term({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "IBM Plex Mono, monospace",
  })
})
```

The `ghostty-web` package is Ghostty. The native terminal emulator written in Zig. Compiled to WebAssembly. It's not xterm.js. It's the same parser that runs in the desktop Ghostty app, just running in your browser.

---

## What Flows Over the Wire

The WebSocket connection streams raw terminal bytes. When you type a character:

1. Your keystroke goes to the browser's ghostty-web instance
2. ghostty-web sends the raw byte over WebSocket to the backend
3. The backend writes that byte to the PTY
4. The shell (or whatever's running in the PTY) processes it
5. Output comes back through the PTY → WebSocket → ghostty-web
6. ghostty-web renders it

This is the same flow as a desktop terminal, just with WebSocket in the middle instead of a direct PTY connection.

```
You type "ls"     →  WebSocket  →  PTY  →  shell processes
                                           ↓
rendered output  ←  WebSocket  ←  PTY  ←  shell outputs file list
```

The browser receives raw ANSI escape sequences. The same bytes your iTerm or Ghostty desktop app would receive. `\x1b[32m` for green text, `\x1b[0m` to reset, cursor positioning codes, everything. ghostty-web parses and renders them.

---

## Multiple Communication Channels

OpenCode uses multiple WebSocket connections for different purposes:

| Channel | Endpoint           | Purpose                                   |
| ------- | ------------------ | ----------------------------------------- |
| PTY     | `/pty/:id/connect` | Terminal I/O (keystrokes ↔ output)        |
| Events  | `/events`          | Real-time status updates, session changes |
| Share   | `/share_poll`      | Live session sharing with others          |

The PTY channel is the "terminal at the bottom." The Events channel powers the rest of the UI. Showing you when the AI is thinking, when files change, etc.

---

## Why This Architecture

OpenCode could have built a chat-style interface that renders messages as HTML. Many AI coding tools do. Instead, they chose to stream real terminal output.

The benefits:

1. **Correctness**: Any program that works in a terminal works in OpenCode. Vim, htop, anything with colors or TUI. It just works because it's a real PTY.

2. **Consistency**: The web experience matches the CLI experience exactly. Same rendering, same keybindings, same everything.

3. **Battle-tested parsing**: Ghostty's terminal parser handles edge cases that simpler approaches miss. By compiling it to WASM, OpenCode gets that correctness for free.

The tradeoff is complexity. You need WASM compilation, WebSocket plumbing, and PTY management. But for a tool that's fundamentally about running code in terminals, it makes sense.

---

## Running Multiple Instances

Because each OpenCode invocation is an independent Bun server:

- `opencode` in project A → port 4096
- `opencode` in project B → port 52341 (random)
- `opencode` in project C → port 49872 (random)

Each has its own sessions, its own PTY processes, its own state. Open each in a different browser tab and they're completely isolated.

Within a single server, you can also run multiple AI sessions in parallel on the same project. The server manages them all.

---

## Summary

OpenCode's web UI is a real terminal emulator (ghostty-web/WASM) connected to a real PTY (on the Bun backend) over WebSocket. Every keystroke travels to the server; every byte of output travels back. Multiple servers can run on different ports, and multiple clients can connect to each server.

It's not a chat interface with terminal styling. It's an actual terminal, streamed to your browser.

---

## Security Note

This architecture. An HTTP server with REST and WebSocket endpoints, no authentication, binding to a predictable port. Turned out to be a serious attack surface. In January 2026, OpenCode received [CVE-2026-22812](https://github.com/anomalyco/opencode/security/advisories/GHSA-vxw4-wv6m-9hhh) for exactly this: any website could hit the server and execute shell commands. The server is now opt-in with optional password auth. See [OpenCode Got an RCE and I Already Wrote the Exploit](./opencode-rce-called-it.md).
