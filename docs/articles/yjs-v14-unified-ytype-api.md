# Yjs v14: Every YType Is Both a Map and a List

Yjs v14 kills the entire type hierarchy. `Y.Text`, `Y.Array`, `Y.Map`, `Y.XmlElement`, `Y.XmlFragment`: all gone. There's one class now: `YType`, exported as `Type`. Every instance is simultaneously a key-value store and an ordered list. This is the biggest breaking change in Yjs history.

## The v13 World: Four Separate Classes

In v13, you pick your data structure upfront:

```js
import * as Y from 'yjs'

const ydoc = new Y.Doc()
const text = ydoc.getText('mytext')     // Y.Text: rich text
const arr = ydoc.getArray('myarray')    // Y.Array: ordered list
const map = ydoc.getMap('mymap')        // Y.Map: key-value store
const xml = ydoc.getXmlFragment('myxml') // Y.XmlFragment: XML tree
```

Each class has its own API. `Y.Map` has `set`/`get`/`delete`. `Y.Array` has `insert`/`push`/`toArray`. `Y.Text` has `insert`/`format`/`toDelta`. They don't share methods. They're completely separate CRDT implementations that happen to share the same underlying linked-list data structure.

## The v14 World: One Class to Rule Them All

```js
import { Doc, Type } from '@y/y'  // package renamed from 'yjs' to '@y/y'

const ydoc = new Doc()
const type = ydoc.get('anything')  // Type, that's it
```

There is no `getText`, `getArray`, `getMap`, or `getXmlFragment`. There's just `get`.

## What Lives Inside a YType

Every single `YType` instance has two data structures living inside it:

```
YType instance
  _map: Map<string, Item>    -- key-value pairs (the "map" side)
  _start: Item | null        -- linked list of ordered children (the "list" side)
  _hasFormatting: boolean    -- whether the list contains rich-text formatting marks
  name: string | null        -- optional tag name (for XML semantics)
```

There is no flag that says "I'm a map" or "I'm an array" or "I'm text." Every YType has both capabilities at all times. You can call `setAttr` AND `insert` on the same instance:

```js
const type = ydoc.get('thing')

// Use it as a map
type.setAttr('title', 'My Document')
type.setAttr('version', 3)

// AND use it as a list: on the same instance
type.insert(0, ['item1', 'item2'])
type.push(['item3'])

// Both coexist
type.getAttr('title')  // 'My Document'
type.get(0)            // 'item1'
type.attrSize          // 2
type.length            // 3
```

This is exactly how an HTML element works. A `<div class="foo">hello</div>` has both attributes (`class="foo"`) and children (`hello`). v14 makes that the universal model for all collaborative data.

## How Each v13 Primitive Maps to v14

### YMap becomes attrs

In v13, `YMap` was a standalone key-value store. In v14, the "map" behavior lives in the attribute side of YType:

```js
// v13
const ymap = ydoc.getMap('settings')
ymap.set('theme', 'dark')
ymap.set('fontSize', 14)
ymap.get('theme')          // 'dark'
ymap.has('fontSize')       // true
ymap.delete('theme')
ymap.forEach((val, key) => { ... })
ymap.size                  // 1

// v14
const ymap = ydoc.get('settings')
ymap.setAttr('theme', 'dark')
ymap.setAttr('fontSize', 14)
ymap.getAttr('theme')       // 'dark'
ymap.hasAttr('fontSize')    // true
ymap.deleteAttr('theme')
ymap.forEachAttr((val, key) => { ... })
ymap.attrSize               // 1
```

Full list of attr methods: `setAttr`, `getAttr`, `hasAttr`, `deleteAttr`, `getAttrs`, `clearAttrs`, `forEachAttr`, `attrKeys`, `attrValues`, `attrEntries`, `attrSize`.

### YArray becomes list operations

In v13, `YArray` was an ordered list. In v14, the "array" behavior lives in the list side (`_start` linked list). The method names are actually identical:

```js
// v13
const yarr = ydoc.getArray('items')
yarr.insert(0, [1, true, false])
yarr.push([4, 5])
yarr.get(0)         // 1
yarr.slice(0, 2)    // [1, true]
yarr.toArray()      // [1, true, false, 4, 5]
yarr.length         // 5

// v14: same method names
const yarr = ydoc.get('items')
yarr.insert(0, [1, true, false])
yarr.push([4, 5])
yarr.get(0)         // 1
yarr.slice(0, 2)    // [1, true]
yarr.toArray()      // [1, true, false, 4, 5]
yarr.length         // 5
```

Full list of list methods: `insert`, `delete`, `push`, `unshift`, `get`, `slice`, `toArray`, `map`, `forEach`, `length`.

### YText becomes list operations with formatting

Text is just a list of characters with optional formatting marks interspersed. The `_hasFormatting` flag tracks whether any `ContentFormat` items exist. Same list storage as arrays, but with string content:

```js
// v13
const ytext = ydoc.getText('editor')
ytext.insert(0, 'Hello ')
ytext.insert(6, 'World', { bold: true })
ytext.format(0, 5, { italic: true })
ytext.toDelta()
// [{ insert: 'Hello ', attributes: { italic: true } },
//  { insert: 'World', attributes: { bold: true } }]

// v14: identical API
const ytext = ydoc.get('editor')
ytext.insert(0, 'Hello ')
ytext.insert(6, 'World', { bold: true })
ytext.format(0, 5, { italic: true })
ytext.toDelta()
// same delta output
```

The difference between a "text insert" and an "array insert" is what you pass. A string produces `ContentString` items, an array produces `ContentAny`/`ContentType` items. This is handled automatically in `applyDelta`:

```js
// From the source: applyDelta checks the op type:
if (delta.$textOp.check(op)) {
  // string insert -> ContentString
  insertContent(transaction, this, currPos, new ContentString(op.insert), ...)
} else if (delta.$insertOp.check(op)) {
  // array insert -> ContentAny/ContentType/ContentBinary/etc
  insertContentHelper(transaction, this, currPos, op.insert, ...)
}
```

So `ytype.insert(0, 'hello')` is a text insert, `ytype.insert(0, [1, 2, 3])` is an array insert. The YType figures it out from the argument type.

### YXmlElement / YXmlFragment becomes YType with a name

This is where the `name` parameter comes in. Here's the actual `Doc.get()` signature:

```js
get(key = '', name = null) {
  return map.setIfUndefined(this.share, key, () => {
    const t = new YType(name)
    t._integrate(this, null)
    return t
  })
}
```

Two parameters:

- **`key`**: the lookup key in `doc.share` (the document's top-level map of shared types). This is how you get the same instance back on every call.
- **`name`**: the "tag name" stored on the YType. When non-null, the YType acts like an XML element with that tag.

```js
// v13
const xml = ydoc.getXmlFragment('layout')  // YXmlFragment (no tag name)
const div = new Y.XmlElement('div')         // has tag name 'div'
xml.insert(0, [div])
div.setAttribute('class', 'container')
div.insert(0, [new Y.XmlText('hello')])
div.toString()  // <div class="container">hello</div>

// v14
const xml = ydoc.get('layout')              // YType with name=null (fragment)
const div = new Type('div')                  // YType with name='div'
xml.insert(0, [div])
div.setAttr('class', 'container')
div.insert(0, ['hello'])                    // strings are just text content
div.toString()  // <div class="container">hello</div>
```

The `name` affects three things:

1. **`toString()`**: uses `name` as the XML tag: `<div>...</div>` vs just the raw content when name is null
2. **Wire format**: `name !== null` uses `YXmlElementRefID`, `name === null` uses `YXmlFragmentRefID` (for backwards compat with v13 encoding)
3. **`toJSON()`**: includes `{ name: 'div', attrs: {...}, children: [...] }` when name is set

But functionally, a named YType and an unnamed YType have the exact same methods. The name is just metadata.

## Nesting Types

You can nest YTypes inside each other, both as list children and as attribute values:

```js
const root = ydoc.get()

// Nest as an attribute (like v13 YMap containing YMap)
root.setAttr('metadata', new Type())
root.getAttr('metadata').setAttr('author', 'Alice')

// Nest as a list child (like v13 YArray containing YArray)
const child = new Type()
root.insert(0, [child])
child.insert(0, [1, 2, 3])

// Or create from deltas
const m1 = Type.from(
  delta.create()
    .setAttr('title', 'Doc')
    .setAttr('nested', delta.create().insert([1, 2, 3]).done())
    .done()
)
```

## The Delta-First Architecture

This is the deeper change. Every mutation goes through `applyDelta`. The convenience methods are all one-liners that build a delta internally:

```js
// From the actual source code:
insert(index, content, format) {
  this.applyDelta(delta.create().retain(index).insert(content, format))
}

delete(index, length = 1) {
  this.applyDelta(delta.create().retain(index).delete(length))
}

format(index, length, formats) {
  this.applyDelta(delta.create().retain(index).retain(length, formats))
}

setAttr(key, value) {
  this.applyDelta(delta.create().setAttr(key, value).done())
}

deleteAttr(key) {
  this.applyDelta(delta.create().deleteAttr(key).done())
}
```

A delta has two parts: **`children`** (list operations: insert, retain, delete) and **`attrs`** (map operations: setAttr, deleteAttr). `applyDelta` processes both:

```js
applyDelta(d) {
  transact(this.doc, transaction => {
    // Process list operations
    for (const op of d.children) {
      if (textOp)   -> insertContent (string)
      if (insertOp) -> insertContentHelper (array items)
      if (retainOp) -> formatText
      if (deleteOp) -> deleteText
      if (modifyOp) -> recursively applyDelta on child type
    }
    // Process map operations
    for (const op of d.attrs) {
      if (setAttrOp)    -> typeMapSet
      if (deleteAttrOp) -> typeMapDelete
    }
  })
}
```

You can also use the delta API directly for compound operations:

```js
import * as delta from 'lib0/delta'

// One atomic delta that does multiple things
const d = delta.create()
  .retain(5)
  .insert('hello', { bold: true })
  .delete(3)
  .setAttr('lastEdited', Date.now())
  .done()

ytype.applyDelta(d)
```

Or use the `change` getter which returns a fresh delta builder:

```js
ytype.change
  .retain(5)
  .insert('world')
  .done()  // auto-applies to the type
```

## Observing Changes

```js
ytype.observe(event => { /* shallow changes to this type */ })
ytype.observeDeep(events => { /* recursive changes to this type and descendants */ })
ytype.unobserve(fn)
ytype.unobserveDeep(fn)
```

Deep observation now reports deltas:

```js
ymap.observeDeep(event => {
  const d = event.deltaDeep
  // delta.create().modifyAttr('nested', delta.create().setAttr('k', 'v'))
})
```

## Migration Cheat Sheet

| v13 | v14 |
|-----|-----|
| `import { Doc } from 'yjs'` | `import { Doc, Type } from '@y/y'` |
| `ydoc.getText('x')` | `ydoc.get('x')` |
| `ydoc.getArray('x')` | `ydoc.get('x')` |
| `ydoc.getMap('x')` | `ydoc.get('x')` |
| `ydoc.getXmlFragment('x')` | `ydoc.get('x')` |
| `new Y.XmlElement('div')` | `new Type('div')` |
| `ymap.set(k, v)` | `ytype.setAttr(k, v)` |
| `ymap.get(k)` | `ytype.getAttr(k)` |
| `ymap.delete(k)` | `ytype.deleteAttr(k)` |
| `ymap.has(k)` | `ytype.hasAttr(k)` |
| `ymap.forEach(fn)` | `ytype.forEachAttr(fn)` |
| `ymap.size` | `ytype.attrSize` |
| `ytext.toDelta()` | `ytype.toDelta()` |
| `ytext.insert(i, s, fmt)` | `ytype.insert(i, s, fmt)` |
| `ytext.format(i, l, fmt)` | `ytype.format(i, l, fmt)` |
| `yarray.insert(i, arr)` | `ytype.insert(i, arr)` |
| `yarray.push([item])` | `ytype.push([item])` |
| `yarray.toArray()` | `ytype.toArray()` |
| `yarray.get(i)` | `ytype.get(i)` |
| `insertAfter()` | Removed: use index-based `insert` |
| Rollup/CJS bundle | Removed: ESM only |

## Why This Design

The INTERNALS.md explains it: "Everything is squeezed into a list in order to reuse the CRDT resolution algorithm." In v13, `YMap`, `YArray`, `YText`, and `YXmlElement` all used the same underlying linked-list CRDT, but each class reimplemented the traversal, insertion, and deletion logic with slight variations. The type hierarchy was an abstraction over what was already the same data structure.

v14 drops the pretense. One class, one linked list, one CRDT algorithm. The map side (`_map`) is a separate `Map<string, Item>` where the last-inserted entry per key wins (earlier entries get marked deleted). The list side (`_start`) is the same ordered linked list that was always there. Formatting marks are just special `ContentFormat` items in the list, same as v13's `YText`.

The unification also means a single YType can model things that were awkward in v13. An XML element naturally has both attributes and children. A document section might have metadata (map) and content (list). In v13 you'd need to nest a `YMap` inside a `YArray` or vice versa. In v14, one type does both.

## Current Status

As of February 2026, v14 is at `14.0.0-22` (pre-release). There is no formal migration guide yet. The binding libraries (`y-quill`, `y-prosemirror`, `y-codemirror`) will need corresponding updates. The `applyDelta` / `toDelta` methods speak the Quill Delta format natively, which should simplify editor bindings once they're updated.
