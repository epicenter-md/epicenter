# The Nested Y.Map Trap: When Yjs Silently Loses Your Data

You're building a collaborative app with Yjs. You've used `Y.Map` and `Y.Array`, and you've learned to trust that "if two people edit at the same time, Yjs will merge it."

So you structure your data like this:

```typescript
const doc = new Y.Doc();
const tables = doc.getMap('tables');

// Create a "posts" table with definition and rows
const posts = new Y.Map();
posts.set(
	'definition',
	new Y.Map([
		['name', 'Posts'],
		['icon', '📝'],
	]),
);
posts.set('rows', new Y.Map());
tables.set('posts', posts);
```

Looks reasonable. Definition and data co-located. Clean hierarchy.

**This will silently lose data when two users create the same table concurrently.**

## The Problem

Here's what happens when Alice and Bob both create a "posts" table at the same time (before syncing):

```
ALICE'S DEVICE                          BOB'S DEVICE
─────────────────                       ─────────────────
const posts = new Y.Map()               const posts = new Y.Map()
posts.set('definition', ...)            posts.set('definition', ...)
posts.set('rows', new Y.Map())          posts.set('rows', new Y.Map())
                                        // Bob also adds initial data:
                                        posts.get('rows').set('row-1', ...)

tables.set('posts', posts)              tables.set('posts', posts)


                    ┌─────────────┐
                    │    SYNC     │
                    └─────────────┘
                           │
                           ▼

                AFTER MERGE: ONE WINS
                ─────────────────────
                Either Alice's "posts" OR Bob's "posts"
                The other is completely gone.

                If Alice wins: Bob's row-1 is lost
                If Bob wins: Alice's definition tweaks are lost
```

This isn't a bug. It's how Yjs works. And understanding _why_ reveals a key distinction in how you should model your data.

## The Mental Model (30 Seconds)

Here's the entire article in a nutshell:

**Yjs can merge edits inside the same shared type.**

**Yjs cannot merge two different shared-type instances assigned to the same map key.**

So there are two very different situations:

| Situation                                        | What happens                                           |
| ------------------------------------------------ | ------------------------------------------------------ |
| Both users edit `posts.rows`                     | ✅ Merges (same Y.Map, different operations inside it) |
| Both users do `tables.set('posts', new Y.Map())` | ❌ One `posts` object wins; the other disappears       |

The conflict happens at `tables['posts']` (the reference), not inside `posts['rows']` (the contents).

## Root vs Nested: Two Different Worlds

### Root level: named singletons

At the document root, shared types are **named singletons**:

```typescript
// doc.getMap('tables') always gives you "the tables map" for this document
const tables1 = doc.getMap('tables');
const tables2 = doc.getMap('tables');
tables1 === tables2; // true - same instance

// Even across clients, before sync:
// Client A: doc.getMap('tables')
// Client B: doc.getMap('tables')
// After sync: Same Y.Map, contents merged ✓
```

The first call creates the map. Subsequent calls return the same instance. When two clients both "create" it before syncing, Yjs recognizes they mean the same thing and merges their contents.

### Nested level: collision-prone

When you do this:

```typescript
tables.set('posts', new Y.Map());
```

You're not "creating the `posts` table" in a named, mergeable way.

You're creating a **brand-new** `Y.Map` instance and storing a **reference** to it under the key `'posts'`.

If two clients do that concurrently, there are now two different `Y.Map` objects competing for the same map entry (`tables['posts']`). Yjs resolves that conflict deterministically by picking one value for the `'posts'` key.

The losing branch is discarded. All the data inside it: gone.

> **Note on "last writer wins":** It's not wall-clock time. Yjs orders operations deterministically using internal clocks and a client tie-breaker, so every peer picks the same winner. See [The Surprising Truth About LWW in CRDTs](./crdt-last-write-wins-surprise.md) for details.

## The Visual

```
ROOT LEVEL                           NESTED LEVEL
────────────                         ────────────

doc.getMap('tables')                 tables.set('posts', new Y.Map())
       │                                    │
       ▼                                    ▼
  ┌─────────┐                         ┌─────────┐
  │  SAFE   │                         │ DANGER  │
  │         │                         │         │
  │ Named   │                         │ Two     │
  │ single- │                         │ Y.Maps  │
  │ ton:    │                         │ compete │
  │ same    │                         │ for one │
  │ name =  │                         │ key     │
  │ same    │                         │         │
  │ object  │                         │ One     │
  │         │                         │ wins,   │
  │ Contents│                         │ other   │
  │ merge   │                         │ dropped │
  └─────────┘                         └─────────┘
```

## A Concrete Example: Notion-Like Tables

Say you're building an app where users can create tables with custom schemas:

```
Y.Map('tables')
  └── posts                              // Y.Map
      ├── definition                     // Y.Map
      │   ├── name: "Posts"
      │   ├── icon: "📝"
      │   └── fields                     // Y.Map
      │       ├── id: { type: 'id' }
      │       └── title: { type: 'text' }
      │
      └── rows                           // Y.Map<rowId, RowMap>
          ├── row-1: { id: '...', title: 'Hello' }
          └── row-2: { id: '...', title: 'World' }
```

Two users both decide to create a "posts" table. Neither knows the other is doing it. They sync.

**Result**: One user's entire table, definition and all rows, is gone. No conflict marker. No merge. Just... gone.

## The Safety Matrix

This table is about one specific risk: **concurrent creation of the same map key**.

If a key is guaranteed unique (like a UUID), the "collision-prone" cases become safe in practice.

| Operation                       | Safe?              | Why                                       |
| ------------------------------- | ------------------ | ----------------------------------------- |
| `doc.getMap('name')`            | ✅ Safe            | Root-level singleton                      |
| `doc.getArray('name')`          | ✅ Safe            | Root-level singleton                      |
| `doc.getText('name')`           | ✅ Safe            | Root-level singleton                      |
| `map.set('key', primitive)`     | ✅ Safe            | Overwrites value only, not a whole branch |
| `map.set('key', existingYMap)`  | ✅ Safe            | Reference to already-shared type          |
| `map.set('key', new Y.Map())`   | ⚠️ Collision-prone | One reference wins; losing branch dropped |
| `map.set('key', new Y.Array())` | ⚠️ Collision-prone | Same issue as Y.Map                       |
| `array.push([new Y.Map()])`     | ✅ Safe            | Each push creates a unique position       |
| Edits inside existing Y.Map     | ✅ Safe            | Contents merge                            |

> **Common wrong fix:** Checking `if (!tables.get('posts')) tables.set('posts', new Y.Map())` does **not** prevent the race. Both clients can pass the check before either syncs. It only helps within a single client session.

## Solutions

All fixes boil down to the same idea: **avoid two users writing different objects to the same map key**.

The simplest way: use stable IDs for storage, and treat human-readable names as data (not keys).

### Solution 1: Use IDs for Keys, Names as Fields

If your keys are always UUIDs, concurrent creation of the same key is essentially impossible:

```typescript
function createTable(name: string) {
	const tableId = crypto.randomUUID(); // "550e8400-e29b-41d4-..."
	tables.set(
		tableId,
		new Y.Map([
			['name', name], // Human name is data, not the key
			['definition', new Y.Map()],
			['rows', new Y.Map()],
		]),
	);
	return tableId;
}

// To look up by name, maintain a separate index
const nameToId = doc.getMap('tableNameIndex');
nameToId.set('posts', tableId);
```

Two clients both creating a table named "posts" will generate different UUIDs. No collision, no data loss. The name index might have a collision, but that's just a string value (safe LWW), not an entire data branch.

**This is the recommended default for most apps.**

### Solution 2: Use Arrays for Collections

Arrays don't have key collisions; each push creates a unique position:

```typescript
const tables = doc.getArray('tables');

tables.push([
	new Y.Map([
		['id', crypto.randomUUID()],
		['name', 'Posts'],
		['definition', new Y.Map()],
		['rows', new Y.Map()],
	]),
]);
```

**Downside**: O(n) lookup by name/ID. Works for small collections.

### Solution 3: Separate Y.Docs (Advanced)

This is an advanced option. It's a great fit if you already want per-entity loading/persistence, but it's more moving parts than most apps need.

The idea: make each table its own Y.Doc, so you get root-level singleton safety everywhere:

```typescript
// Directory doc (lightweight, always loaded)
const directoryDoc = new Y.Doc({ guid: 'workspace:directory' });
const tableRegistry = directoryDoc.getMap('tables');

// Each table is its own Y.Doc
function getTableDoc(tableName: string) {
	// Same GUID = same doc = safe concurrent creation
	return new Y.Doc({ guid: `workspace:table:${tableName}` });
}

const postsDoc = getTableDoc('posts');
const definition = postsDoc.getMap('definition'); // Root-level: SAFE
const rows = postsDoc.getMap('rows'); // Root-level: SAFE
```

Now when Alice and Bob both create the "posts" table:

- They both create `Y.Doc({ guid: 'workspace:table:posts' })`
- They both call `postsDoc.getMap('definition')` and `postsDoc.getMap('rows')`
- Because these are root-level calls on the same doc GUID, Yjs merges their contents

**Tradeoffs**: Multiple sync connections, more complex persistence, harder debugging. But you get safe concurrent creation for any named entity, plus lazy loading and per-entity persistence.

## When Does This Actually Bite You?

Honestly? Not that often. Concurrent creation of the _same named entity_ is rare in most apps:

- **Row IDs are UUIDs**: collision essentially impossible
- **Table creation is typically one admin**: not racing
- **KV keys are defined in code**: not runtime-created

The common case, concurrent _edits_ to existing entities, works perfectly with Yjs.

But if you're building something where:

- Users can create named entities (tables, channels, projects)
- Multiple users might create the same name simultaneously
- Data loss on collision is unacceptable

Then you need one of the solutions above.

## Try It Yourself

See the data loss with your own eyes. Run with `bun run demo.ts`:

```typescript
import * as Y from 'yjs';

const docA = new Y.Doc();
const docB = new Y.Doc();

const tablesA = docA.getMap('tables');
const tablesB = docB.getMap('tables');

// Both clients create "posts" with different data
tablesA.set(
	'posts',
	new Y.Map([
		['rows', 10],
		['owner', 'Alice'],
	]),
);
tablesB.set(
	'posts',
	new Y.Map([
		['rows', 5],
		['config', "Bob's config"],
	]),
);

// Sync
Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

const posts = tablesA.get('posts') as Y.Map<unknown>;
console.log("Winner's data:", Object.fromEntries(posts.entries()));
// One client's ENTIRE Y.Map is gone. No merge. No warning.
```

## TL;DR

1. **Root-level `doc.getMap()` is safe**: named singleton, merges across clients
2. **Nested `map.set('key', new Y.Map())` is collision-prone**: one reference wins on concurrent creation
3. **Use IDs for keys, names as data**: the simplest fix for most apps
4. **Use subdocs for named entities** if you need guaranteed concurrent creation safety
5. **Edits inside existing Y.Maps are always safe**: it's only _creation_ that's risky

The structure of your Yjs document isn't just about convenience; it's about conflict safety. Design accordingly.

---

_See also:_

- [Root vs Nested: The Two Worlds of `.get()` in Yjs](./yjs-root-vs-nested-get.md): Why root-level and nested behave completely differently
- [The Surprising Truth About "Last Write Wins" in CRDTs](./crdt-last-write-wins-surprise.md): Why "last" doesn't mean what you think
- [Yjs Internals](https://github.com/yjs/yjs/blob/main/INTERNALS.md): How Yjs actually resolves conflicts
