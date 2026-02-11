# Cell Workspace: A Cell-Level CRDT Architecture for Spreadsheet-Like Data

**Related PR**: [#1288](https://github.com/EpicenterHQ/epicenter/pull/1288)

---

The **Cell Workspace** is a cell-level CRDT architecture designed for spreadsheet-like data where every individual cell can be edited independently without conflicts.

The key insight is that most data editing in tables happens at the cell level, not the row level. When two users edit different cells in the same row, those edits should both win. Traditional row-based storage treats the entire row as an atomic unit, causing unnecessary conflicts.

```
Traditional (row-level):
┌─────────────────────────────────────────────────────────┐
│  Row "abc123"                                           │
│  { title: "Hello", views: 100, author: "Alice" }       │
└─────────────────────────────────────────────────────────┘
        │                           │
    User A edits title         User B edits views
        │                           │
        ▼                           ▼
  { title: "Hi" }            { views: 200 }

  ⚠️ CONFLICT - entire row replaced, one user loses


Cell Workspace (cell-level):
┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│ abc123:title   │  │ abc123:views   │  │ abc123:author  │
│ "Hello"        │  │ 100            │  │ "Alice"        │
└────────────────┘  └────────────────┘  └────────────────┘
        │                   │
    User A                 User B
        │                   │
        ▼                   ▼
┌────────────────┐  ┌────────────────┐
│ abc123:title   │  │ abc123:views   │
│ "Hi"           │  │ 200            │
└────────────────┘  └────────────────┘

  ✓ Both edits preserved - no conflict
```

---

## The Data Model

Each table is stored as a Y.Array containing timestamped cell entries. The key encodes both row and field:

```
Y.Doc
├── Y.Array("table:posts")           ← prefixed to avoid collisions
│   ├── { key: "row1:title",     val: "Hello World",  ts: 1706200000000 }
│   ├── { key: "row1:views",     val: 100,            ts: 1706200000001 }
│   ├── { key: "row1:published", val: true,           ts: 1706200000002 }
│   ├── { key: "row2:title",     val: "Another Post", ts: 1706200001000 }
│   └── ...
├── Y.Array("table:users")
│   └── ...
└── Y.Array("kv")                    ← workspace-level settings
    ├── { key: "theme", val: "dark", ts: ... }
    └── { key: "lang",  val: "en",   ts: ... }
```

The `ts` (timestamp) field enables Last-Write-Wins conflict resolution. When the same cell is edited on two offline devices, the later timestamp wins after sync:

```
Device A (2:00pm): set("row1:title", "Draft")     ts=1706200400000
Device B (3:00pm): set("row1:title", "Final")     ts=1706204000000

After sync: "Final" wins (higher timestamp), regardless of sync order
```

---

## Schema is External and Advisory

Unlike traditional databases, the schema lives outside the CRDT as a plain JSON definition. This is intentional:

```typescript
const definition: WorkspaceSchema = {
  name: "My Blog",
  tables: {
    posts: {
      name: "Posts",
      fields: {
        title:     { name: "Title",     type: "text",    order: 1 },
        views:     { name: "Views",     type: "integer", order: 2 },
        published: { name: "Published", type: "boolean", order: 3 },
      },
    },
  },
};
```

The schema acts as a **lens** for viewing data, not a constraint on what can be stored. Data that doesn't match the schema is flagged but never rejected. This is critical for CRDTs - you can't reject writes without breaking convergence.

```
          ┌─────────────────┐
          │  External JSON  │
          │    (schema)     │
          └────────┬────────┘
                   │ advisory validation
                   ▼
┌─────────────────────────────────────┐
│         Y.Doc (data)                │
│                                     │
│  All writes succeed.                │
│  Invalid data is flagged on read.  │
└─────────────────────────────────────┘
```

---

## The API

Creating a workspace gives you access to table helpers:

```typescript
import { createCellWorkspace } from "@epicenter/epicenter/cell";

const workspace = createCellWorkspace({
  id: "blog-workspace",
  definition,
});

const posts = workspace.table("posts");
```

Writing is straightforward - validation never blocks writes:

```typescript
const rowId = posts.createRow();  // generates "v1stgxr8z5jd"

posts.set(rowId, "title", "Hello World");
posts.set(rowId, "views", 100);
posts.set(rowId, "published", true);

// Even invalid data is accepted (CRDT-friendly)
posts.set(rowId, "views", "not a number");  // stores it anyway
```

Reading returns result types that tell you validation status:

```typescript
// Validated reads
const cell = posts.get(rowId, "views");
// { status: "invalid", key: "row1:views", errors: [...], value: "not a number" }

const row = posts.getRow(rowId);
// { status: "invalid", id: "row1", errors: [...], row: { title: "Hello", views: "not a number", ... } }

// Bulk operations
const allRows = posts.getAll();        // RowResult[] - each has status
const validOnly = posts.getAllValid(); // RowData[] - pre-filtered
const problems = posts.getAllInvalid(); // InvalidRowResult[] - with errors
```

Raw values are always available in results, even when invalid:

```typescript
// Invalid results still include the value
if (result.status === "invalid") {
  const rawValue = result.value;  // "not a number" - always accessible
  const errors = result.errors;   // validation errors for display
}
```

---

## TypeBox Validation

Validation uses TypeBox with JIT-compiled validators. The schema is converted to TypeBox at construction time:

```
SchemaFieldDefinition          TypeBox Schema
──────────────────────────     ─────────────────────────────────────────
{ type: "text" }          →    Type.Optional(Type.Union([String, Null]))
{ type: "integer" }       →    Type.Optional(Type.Union([Integer, Null]))
{ type: "select",
  options: ["a","b"] }    →    Type.Optional(Type.Union([Literal("a"), Literal("b"), Null]))
```

All fields are Optional (missing is valid) and Nullable (null is valid). The table schema uses `additionalProperties: true` so unknown fields pass validation. This preserves the advisory nature.

---

## Observation

Tables emit granular change events:

```typescript
posts.observe((changes, transaction) => {
  for (const change of changes) {
    switch (change.type) {
      case "add":
        console.log(`New cell: ${change.key} = ${change.value}`);
        break;
      case "update":
        console.log(`Updated: ${change.key}: ${change.previousValue} → ${change.value}`);
        break;
      case "delete":
        console.log(`Deleted: ${change.key}`);
        break;
    }
  }
});
```

Keys are in `rowId:fieldId` format, so you can easily parse which row/field changed.

---

## Sync Just Works

Because each cell is an independent CRDT entry, syncing between devices is straightforward:

```typescript
// Two workspaces, same ID = will sync
const ws1 = createCellWorkspace({ id: "shared", definition });
const ws2 = createCellWorkspace({ id: "shared", definition });

// Make edits on ws1
ws1.table("posts").set("row1", "title", "From Device 1");

// Sync: ws1 → ws2
Y.applyUpdate(ws2.ydoc, Y.encodeStateAsUpdate(ws1.ydoc));

// ws2 now has the data
const result = ws2.table("posts").get("row1", "title");
// result.value === "From Device 1"
```

Concurrent edits to different cells both win. Concurrent edits to the same cell use LWW (later timestamp wins).

---

## Why This Architecture?

**Cell-level granularity** means fewer conflicts. In a collaborative spreadsheet, users rarely edit the exact same cell at the exact same time. But they often edit different cells in the same row simultaneously. Cell-level storage turns row conflicts into independent, conflict-free edits.

**Advisory schema** means the CRDT always converges. Traditional databases reject invalid data, but CRDTs can't do that - if one replica rejects a write that another accepts, they'll never converge. By validating on read instead of write, we get type safety without breaking CRDT semantics.

**Last-Write-Wins timestamps** give intuitive offline behavior. When you edit on a plane and sync later, your edits are timestamped when you made them. If someone else edited the same cell while you were offline, the later edit wins - which matches user expectations.

**External schema** means schema changes don't require data migration. The schema is just metadata describing how to interpret the data. You can add fields, remove fields, or change types without touching the underlying CRDT. Old data keeps working; it's just flagged as invalid against the new schema.
