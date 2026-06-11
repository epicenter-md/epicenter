# Yjs Has Free WebSocket Infrastructure (Just for Demos)

**You can prototype collaborative Yjs apps on a public WebSocket server with zero setup: `wss://demos.yjs.dev/ws`. No authentication, no credit card, no infrastructure.**

> It's a community resource from Yjs maintainers, not production infrastructure.

If you want to build a quick collaborative prototype without setting up your own server, Yjs provides a public WebSocket relay running at `wss://demos.yjs.dev/ws`. All 8 official demos use it. You can too.

It works exactly like this:

```javascript
import { WebsocketProvider } from 'y-websocket'
import { Y } from 'yjs'

const ydoc = new Y.Doc()
const provider = new WebsocketProvider(
  'wss://demos.yjs.dev/ws',
  'my-awesome-app-2026-02-10',  // room name
  ydoc
)

const ytext = ydoc.getText('shared-text')

ytext.observe(event => {
  console.log('Text changed:', ytext.toString())
})

// From another tab/browser:
ytext.insert(0, 'Hello, ')  // syncs instantly
```

Open this in two browser tabs pointing to the same room and they sync instantly. No database. No authentication. No deployment.

## How It Works

The server is organized by room. Your room name is just a string. Everyone who connects with the same room name joins the same session:

```
┌────────────────────────────────────────┐
│ wss://demos.yjs.dev/ws                 │
├────────────────────────────────────────┤
│                                        │
│  Room: 'quill-demo-2026-02-10'        │
│  ├─ Client A (browser tab)            │
│  ├─ Client B (another device)         │
│  └─ Client C (mobile)                 │
│                                        │
│  Room: 'my-awesome-app-2026-02-10'    │
│  ├─ Your client                       │
│  └─ Anyone else with that room name   │
│                                        │
│  Room: 'anything-you-want'            │
│  └─ (empty until someone connects)    │
│                                        │
└────────────────────────────────────────┘
```

The official demos use date-based room names so they reset daily:

```javascript
const roomname = `quill-demo-${new Date().toLocaleDateString('en-CA')}`
// 2026-02-10 → 'quill-demo-2026-02-10'
```

For your own prototypes, just pick any room name. There's no registration, no access control. If someone else guesses your room name, they can join and see (and edit) everything. Keep that in mind.

## What You Actually Get

- Full Yjs sync protocol (Sync Step 1, Sync Step 2, continuous updates)
- Awareness protocol (cursor positions, user state, presence)
- Multi-client coordination (50 clients in one room, they all converge)
- Document persistence in memory (persists until server restarts)
- Automatic synchronization on reconnect

All the collaboration infrastructure, none of the setup.

## The Warning

**Do not use this in production.** Here's why:

- No uptime guarantee (could go down, get rate-limited, or disappear)
- No persistence guarantee (server restarts lose data)
- Rooms are public (anyone with the room name can join)
- No authentication (you can't restrict access)
- No compliance (no GDPR/CCPA/SOC2)
- Single-region (latency to distant clients)

If your prototype becomes something real, migrate to self-hosted or a commercial provider.

## When to Use It

✓ **Quick prototypes**: MVP in an afternoon
✓ **Learning Yjs**: no server setup distraction
✓ **Testing integrations**: try a binding before committing
✓ **Hackathons/jamming**: collaborative session for a few hours
✓ **Demos**: show how collaboration works
✓ **Proof of concept**: validate an idea before building infrastructure

✗ **Production apps**: needs guarantees
✗ **Sensitive data**: it's public
✗ **Long-term persistence**: you need durability
✗ **Scale**: one shared room gets slow with many clients

## Simple Example: Shared Todo List

```javascript
import { WebsocketProvider } from 'y-websocket'
import { Y } from 'yjs'

const ydoc = new Y.Doc()
const provider = new WebsocketProvider(
  'wss://demos.yjs.dev/ws',
  'shared-todos-' + new Date().toLocaleDateString(),
  ydoc
)

const todos = ydoc.getArray('todos')

// Add a todo (syncs to all clients)
const addTodo = (text) => {
  const todo = new Y.Map()
  todo.set('id', Math.random().toString(36))
  todo.set('text', text)
  todo.set('done', false)
  todos.push([todo])
}

// Listen to changes
todos.observe(event => {
  console.log('Todos updated:', todos.toArray())
})

// From another browser tab, todos sync automatically
addTodo('Buy milk')
addTodo('Learn Yjs')
```

Share the room name with friends, they open the same URL, and you're collaborating.

## Transitioning to Self-Hosted

When your prototype becomes real, swap `demos.yjs.dev/ws` for your own server:

```javascript
// Before (demos)
const provider = new WebsocketProvider(
  'wss://demos.yjs.dev/ws',
  'my-room',
  ydoc
)

// After (self-hosted)
const provider = new WebsocketProvider(
  'wss://my-server.com/ws',  // your server
  'my-room',
  ydoc
)
```

That's it. Everything else stays the same. The protocol is identical.

To run your own y-websocket server:

```javascript
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'

const wss = new WebSocketServer({ port: 1234 })
const rooms = new Map()

wss.on('connection', (conn, req) => {
  const room = req.url.slice(1) || 'default'
  let ydoc = rooms.get(room)

  if (!ydoc) {
    ydoc = new Y.Doc()
    rooms.set(room, ydoc)
  }

  const state = Y.encodeStateAsUpdate(ydoc)
  conn.send(Buffer.from(state))

  conn.on('message', (message) => {
    Y.applyUpdate(ydoc, new Uint8Array(message))
    for (const peer of wss.clients) {
      if (peer !== conn && peer.readyState === 1) {
        peer.send(message)
      }
    }
  })
})
```

That's your server. Persist to a database if you need durability. Add auth if you need access control. But the core architecture is the same. Thin relay.

## Production Alternatives

When you need durability and guarantees:

- **y-sweet** (Jamsocket): hosted Yjs with persistence and scale
- **Liveblocks**: commercial sync layer with WebSockets and REST APIs
- **PartyKit**: Durable Objects on Cloudflare, built for real-time
- **Self-hosted**: y-websocket server with your database of choice

All speak the same Yjs protocol. Your client code stays identical.

## Why This Exists

Yjs is open source. The maintainers host `demos.yjs.dev` as a community resource so you can:

1. See Yjs in action instantly (no setup, no complexity)
2. Prototype quickly without infrastructure friction
3. Test before committing to a provider
4. Have working demos to share with others

It's not a business. It's a gift to the community to lower the barrier to entry.

---

## References

- [demos.yjs.dev](https://demos.yjs.dev)
- [y-websocket npm package](https://www.npmjs.com/package/y-websocket)
- [y-websocket GitHub](https://github.com/yjs/y-websocket)
- [Yjs documentation](https://docs.yjs.dev)
- [y-sweet hosting](https://jamsocket.com/y-sweet/)

See also: [The Production Patterns Hiding in Yjs Demos](./yjs-demos-production-patterns.md) for architecture details
