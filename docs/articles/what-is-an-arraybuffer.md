# What Is an ArrayBuffer?

An `ArrayBuffer` is a fixed-size chunk of raw binary memory. You can't read or write it directly. You access it through typed array views like `Uint8Array`, `Float32Array`, or `DataView`.

```js
const buffer = new ArrayBuffer(8)  // 8 bytes of raw memory
buffer[0] = 42                     // does nothing: ArrayBuffer has no index access
```

Think of it as a plot of land. The `ArrayBuffer` is the land itself. A `Uint8Array` is one way to build on it. Interpreting each byte as an unsigned integer. A `Float64Array` is another. Interpreting every 8 bytes as a floating-point number. Same land, different buildings.

## You Need a View to Do Anything

All access goes through typed array views. `ArrayBuffer` is deliberately useless on its own.

```js
const buffer = new ArrayBuffer(8)

const bytes = new Uint8Array(buffer)      // 8 elements, 1 byte each
const floats = new Float64Array(buffer)   // 1 element, 8 bytes

bytes[0] = 1
bytes[1] = 2
console.log(floats[0])  // 8.487...e-314 (same bytes, reinterpreted as a 64-bit float)
```

Both views point at the same memory. Writing through one changes what the other sees. This is how JavaScript handles the kind of byte-level reinterpretation that C does with pointer casting.

## Multiple Views, Same Memory

This is where `ArrayBuffer` earns its keep. Different typed arrays can overlay the same buffer, each interpreting the bytes differently.

```js
const buffer = new ArrayBuffer(4)
const u8 = new Uint8Array(buffer)
const u16 = new Uint16Array(buffer)

u8[0] = 0xFF   // 255
u8[1] = 0x00   // 0

console.log(u16[0])  // 255 on little-endian systems (0x00FF)
```

This matters for parsing binary protocols, working with WebGL vertex data, or reading file formats where the same block of bytes contains mixed types. A header with 16-bit integers followed by 32-bit floats.

## Three Ways You'll Get One

Explicitly, when you need raw memory:

```js
const buffer = new ArrayBuffer(1024)  // 1KB of zeros
```

Implicitly, when creating a typed array:

```js
const bytes = new Uint8Array(256)
bytes.buffer  // the underlying ArrayBuffer(256), created automatically
```

From APIs that return binary data:

```js
const response = await fetch('/file.bin')
const buffer = await response.arrayBuffer()  // ArrayBuffer from the network
const bytes = new Uint8Array(buffer)          // now you can read it
```

## ArrayBuffer Is Memory, Uint8Array Is the Lens

People sometimes conflate these. The relationship is simple:

```
ArrayBuffer (raw bytes):  [0x48] [0x65] [0x6C] [0x6C] [0x6F]

Uint8Array view:            72    101    108    108    111
                           'H'   'e'    'l'    'l'    'o'
```

You can't work with an `ArrayBuffer` directly. You always need a view. `Uint8Array` is the most common because most binary APIs deal in byte streams. See [What Is a Uint8Array?](what-is-a-uint8array.md) for when and why you'd reach for that specific view.

## When ArrayBuffer Itself Matters

Most of the time you'll work with `Uint8Array` and let it manage the buffer behind the scenes. But `ArrayBuffer` becomes important in a few situations.

Sharing memory between views. Parsing a binary file where the header is `Uint16Array` and the body is `Float32Array`, both reading from the same allocation without copying.

Transferring data between threads: `postMessage` can transfer `ArrayBuffer` ownership to a Web Worker with zero copy:

```js
const buffer = new ArrayBuffer(1024)
worker.postMessage(buffer, [buffer])  // transferred, not copied
buffer.byteLength                     // 0: ownership moved to the worker
```

Interfacing with WebAssembly. Wasm linear memory is an `ArrayBuffer`, and typed arrays are the bridge between JavaScript and Wasm functions.

In all three cases, the `ArrayBuffer` is what crosses the boundary. The views are just how you read and write once you have it.
