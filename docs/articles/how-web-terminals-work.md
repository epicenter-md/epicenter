# How Web Terminals Work

When you see a terminal running inside a browser. Like a web-based SSH client, VS Code's remote terminal, or Replit's console. It looks exactly like the real thing. That's because, in a sense, it _is_ the real thing. The browser is literally receiving raw terminal output and rendering it with a JavaScript-based terminal emulator.

This article explains how that works.

---

## What Terminal Emulators Actually Do

A terminal emulator has one job: interpret a stream of bytes and render them visually. Most of those bytes are just text, but some are **ANSI escape sequences**: special codes that control formatting, cursor position, colors, and more.

For example, the bytes `\x1b[32mHello\x1b[0m` mean:

- `\x1b[32m` → switch to green text
- `Hello` → print "Hello"
- `\x1b[0m` → reset formatting

When you run a CLI tool like `ls --color` or `vim`, the program writes these escape sequences to stdout. The terminal emulator parses them and draws the appropriate output.

This is true whether your terminal is iTerm, Ghostty, Windows Terminal, or xterm.js running in a browser.

---

## The Desktop Architecture

On a desktop, the flow looks like this:

```
┌────────────────────────────────────────────┐
│  Terminal Emulator (Ghostty, iTerm, etc.)  │
│  ┌──────────────────────────────────────┐  │
│  │  PTY (pseudo-terminal)               │  │
│  │  ┌────────────────────────────────┐  │  │
│  │  │  Shell (zsh, bash)             │  │  │
│  │  │  ┌──────────────────────────┐  │  │  │
│  │  │  │  Your program (vim, ls)  │  │  │  │
│  │  │  └──────────────────────────┘  │  │  │
│  │  └────────────────────────────────┘  │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

The **PTY** (pseudo-terminal) is a kernel-level abstraction that mimics a hardware terminal. It's a bidirectional pipe: the shell writes output to it, and the terminal emulator reads from it. When you type, the terminal emulator writes to the PTY, and the shell reads it.

Programs don't know or care whether they're running in a "real" terminal or an emulator. They just read from stdin and write to stdout. The PTY makes everything look the same.

---

## The Web Architecture

Here's the interesting part: web terminals use the exact same byte stream. They just transport it over the network.

```
┌──────────────────┐       WebSocket        ┌────────────────────┐
│     Browser      │◄──────────────────────►│      Server        │
│                  │    raw PTY bytes       │                    │
│   xterm.js or    │   (ANSI sequences)     │   PTY ← shell      │
│   libghostty-vt  │                        │          ↑         │
│                  │                        │       program      │
└──────────────────┘                        └────────────────────┘
```

The server creates a PTY, spawns a shell, and streams the PTY's output over a WebSocket. The browser receives the raw bytes, escape sequences and all, and feeds them to a JavaScript terminal emulator.

When you type, keystrokes are sent back over the WebSocket. The server writes them to the PTY. The shell processes them, produces output, and the cycle continues.

This is exactly what tools like **ttyd**, **wetty**, and **gotty** do. It's also how VS Code's remote terminal works when you connect to a server.

---

## Terminal Emulator Libraries

Several libraries exist for rendering terminal output in a browser:

### xterm.js

The most popular option. Used by VS Code, Hyper, and many web SSH clients. It's a TypeScript library that handles:

- VT100/xterm escape sequence parsing
- Text rendering with WebGL or Canvas
- Mouse and keyboard input
- Selection and clipboard

### libghostty-vt (WebAssembly)

Ghostty. A native terminal emulator written in Zig. Ships `libghostty-vt`, a library containing just the terminal parsing logic. It can be compiled to WebAssembly, meaning you can use Ghostty's battle-tested parser in a browser.

This is useful if you want a more correct or performant parser than xterm.js provides. You'd still need to handle rendering yourself (or integrate with another library).

### Other Options

- **hterm** (Google's terminal for Chrome OS)
- **terminaljs** (lightweight, less feature-complete)

---

## Not Everything Is a Web Terminal

It's important to distinguish true web terminals from chat interfaces:

| Web Terminal                       | Chat Interface                |
| ---------------------------------- | ----------------------------- |
| Streams raw PTY bytes              | Sends structured JSON         |
| Uses ANSI escape sequences         | Uses Markdown/HTML            |
| Terminal emulator in browser       | Standard web UI components    |
| Examples: web SSH, Replit terminal | Examples: ChatGPT, Claude web |

When you use Claude or ChatGPT in a browser, there's no terminal involved. The server sends structured data (usually JSON over Server-Sent Events or WebSocket), and the frontend renders it as formatted HTML.

CLI tools like OpenCode, on the other hand, run _inside_ a terminal. They write ANSI escape sequences to stdout, and your terminal emulator (Ghostty, iTerm, whatever) renders them. If you wanted OpenCode in a browser, you'd need to:

1. Run OpenCode on a server inside a PTY
2. Stream the PTY output over WebSocket
3. Render it with xterm.js or similar

---

## Why This Matters

Understanding this architecture clarifies several things:

1. **Why web terminals feel native**: They're rendering the exact same bytes a desktop terminal would. The only difference is transport.

2. **Why latency matters**: Every keystroke requires a round-trip to the server. This is why local terminals feel snappier than web-based ones.

3. **Why you can't "just port" a CLI to the web**: A CLI tool expects to run inside a PTY. To use it in a browser, you need the full stack: server-side PTY, WebSocket transport, and client-side terminal emulator.

4. **Why projects like libghostty-vt exist**: Building a correct terminal parser is hard. By extracting it into a library (especially one that compiles to WASM), other projects can reuse that work.

---

## Summary

A web terminal is simpler than it looks: raw bytes over WebSocket, parsed by a JavaScript terminal emulator. The same escape sequences that make `vim` work in iTerm make it work in a browser. You just need the right plumbing to get them there.
