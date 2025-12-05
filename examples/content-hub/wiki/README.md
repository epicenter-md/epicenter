# Wiki Workspace

Evergreen knowledge base entries that serve as the source of truth for all content.

## What Are Wiki Entries?

Wiki entries are permanent reference documents on specific topics. Unlike blog posts or articles that have a publication date and become stale, wiki entries are living documents that you continuously update as your understanding evolves.

Think of them like your personal Wikipedia: authoritative, topic-focused, and always current.

## Content Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   wiki.entries                                                  │
│   ────────────                                                  │
│   Source of truth. Permanent. Evergreen.                        │
│   Your authoritative take on a topic.                           │
│                                                                 │
│              │                                                  │
│              │ derives                                          │
│              ▼                                                  │
│                                                                 │
│   posts.*                                                       │
│   ───────                                                       │
│   Distribution. Platform-specific. Timestamped.                 │
│   Twitter, Reddit, YouTube, etc.                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Every post must reference a wiki entry via `entry_id`. This enforces a disciplined workflow: think first (wiki), then distribute (posts).

## Dual Markdown Indexes

The wiki workspace has two markdown indexes for different purposes:

### 1. Local Storage (`markdown`)

Default storage for all wiki content. Uses the standard `withBodyField('content')` config.

```typescript
// Sync operations
pullToMarkdown(); // YJS → local markdown files
pushFromMarkdown(); // local markdown files → YJS
```

### 2. Blog Content Collection (`blog`)

Syncs entries to your Astro blog at `/Users/braden/Code/blog/src/content/articles/`.

Field names are kept consistent (no remapping). Dates are serialized as Date objects with timezone stored separately.

```typescript
// Sync operations
pullToBlog(); // YJS → blog content collection
pushFromBlog(); // blog content collection → YJS
```
