# What Is a Uint8Array?

A `Uint8Array` is a fixed-size block of raw bytes where every element is an unsigned 8-bit integer (0-255). Unlike a regular `Array`, which can hold anything and grows dynamically, a `Uint8Array` sits on top of contiguous binary memory and does exactly one thing: store small integers efficiently.

```js
const arr = [42, "hello", { x: 1 }, null]  // Array: anything goes
const buf = new Uint8Array(4)               // Uint8Array: 4 bytes, all zeros
```

That difference in flexibility is also a difference in cost. A regular `Array` stores each element as a full JavaScript value: 8 to 16 bytes of overhead per slot, scattered across the heap. A `Uint8Array` stores each element as exactly one byte, packed tightly in a single contiguous allocation.

## Regular Arrays Accept Everything; Uint8Arrays Don't

A `Uint8Array` silently coerces everything to a number between 0 and 255. Values that don't fit get wrapped.

```js
const buf = new Uint8Array(4)
buf[0] = 255     // fine
buf[1] = 256     // wraps to 0 (overflow)
buf[2] = -1      // wraps to 255 (unsigned)
buf[3] = "hello" // becomes 0 (NaN coerces to 0)
```

No errors, no warnings. If you put in a value outside the range, it keeps the lowest 8 bits. This is the same behavior as an unsigned byte in C.

## You Can't Push or Pop

`Uint8Array` is fixed-size. There's no `push`, `pop`, or `splice`. You choose the size at creation and that's it.

```js
const buf = new Uint8Array(3)
buf.push(1)  // TypeError: buf.push is not a function
```

If you need to grow, create a new one and copy:

```js
const old = new Uint8Array([1, 2, 3])
const bigger = new Uint8Array(6)
bigger.set(old)  // copies old into the first 3 slots
```

This is deliberate. Fixed-size means the engine can allocate one contiguous block and never move it, which is critical when you're processing thousands of bytes per frame.

## A Uint8Array Is a View Into an ArrayBuffer

A `Uint8Array` doesn't own memory directly. It's a *view* into an `ArrayBuffer`: a chunk of raw, untyped bytes.

```js
const buffer = new ArrayBuffer(4)       // 4 bytes of raw memory
const view = new Uint8Array(buffer)     // interpret those bytes as unsigned 8-bit ints

view[0] = 72   // 'H'
view[1] = 101  // 'e'
view[2] = 108  // 'l'
view[3] = 108  // 'l'
```

You can skip the explicit `ArrayBuffer`: `new Uint8Array(4)` creates one under the hood. But understanding the relationship matters when multiple views share the same memory. See [What Is an ArrayBuffer?](what-is-an-arraybuffer.md) for the full picture.

## Uint8Array Is One of Many Typed Arrays

`Uint8Array` is the most common typed array, but it has siblings. They all work the same way: fixed-size views over an `ArrayBuffer`, just with different element sizes and signedness.

```js
new Int8Array(4)      // signed: -128 to 127
new Uint16Array(4)    // unsigned: 0 to 65535, 2 bytes each
new Int32Array(4)     // signed: -2B to 2B, 4 bytes each
new Float32Array(4)   // 32-bit floats, 4 bytes each
new Float64Array(4)   // 64-bit floats (same as JS numbers), 8 bytes each
new BigInt64Array(4)  // 64-bit BigInts, 8 bytes each
```

`Uint8Array` dominates because most binary APIs deal in byte streams, and a byte is an unsigned 8-bit integer.

## When You'll Hit It

`Uint8Array` shows up anywhere you're working with raw binary data:

- File I/O: reading and writing files returns `Uint8Array`, not strings
- Network: WebSocket binary messages, fetch response bodies via `.arrayBuffer()`
- Crypto: `crypto.subtle.encrypt()` returns and accepts `ArrayBuffer`/`Uint8Array`
- CRDTs: Yjs encodes document state as `Uint8Array` via `Y.encodeStateAsUpdate()`
- Tauri IPC: binary data transfer between Rust and JavaScript

If you're building something that touches files, sockets, or encryption, you'll encounter `Uint8Array` within the first hour.

## Side by Side

| | `Array` | `Uint8Array` |
|---|---|---|
| Element types | Anything | Only integers 0-255 |
| Size | Dynamic (`push`/`pop`) | Fixed at creation |
| Memory per element | 8-16 bytes (boxing overhead) | Exactly 1 byte |
| Memory layout | Sparse, non-contiguous | Contiguous binary buffer |
| Backed by | JS engine internals | An `ArrayBuffer` |

A regular `Array` is a general-purpose container. A `Uint8Array` is a byte buffer. One job, no overhead.
