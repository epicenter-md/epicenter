# Basic Workspace Example

This example demonstrates how to define and run an Epicenter workspace with full CLI support and markdown persistence.

## What's This?

This folder shows you how to:
1. Define a workspace using `epicenter.config.ts`
2. Run the workspace programmatically with the client API
3. Use the CLI to execute actions from the command line
4. Persist data to markdown files for git-friendly storage

## Structure

```
basic-workspace/
├── .epicenter/                  # Internal state and index artifacts
│   ├── blog.yjs                 # Binary YJS document (CRDT source of truth)
│   ├── blog.db                  # SQLite index database
│   └── blog/                    # Index-specific logs and diagnostics
│       ├── markdown.log                  # (indexId = "markdown")
│       ├── markdown.diagnostics.json
│       └── sqlite.log                    # (indexId = "sqlite")
├── .data/
│   └── content/                 # Markdown files (git-friendly storage)
│       ├── posts/               # Blog posts as .md files
│       └── comments/            # Comments as .md files
├── epicenter.config.ts          # Workspace definition (with setupYDoc)
├── cli.ts                       # CLI entry point
├── yjs-persistence.test.ts      # Automated test: YJS persistence across sessions
├── bidirectional-sync.test.ts   # Automated test: markdown file bidirectional sync
├── package.json                 # Scripts
└── README.md                    # This file
```

## The Blog Workspace

This example implements a blog workspace with:

### Tables
- **posts**: Blog posts with title, content, category, views, and publish date
- **comments**: Comments on posts

### Actions
- `getPublishedPosts()`: Query all published posts
- `getPost({ id })`: Query a specific post by ID
- `getPostComments({ postId })`: Query comments for a post
- `createPost({ title, content, category })`: Create a new post
- `publishPost({ id })`: Publish a post
- `addComment({ postId, author, content })`: Add a comment to a post
- `incrementViews({ id })`: Increment view count for a post

### Indexes
- **sqlite**: SQLite index for querying posts and comments
- **markdown**: Markdown persistence for git-friendly storage

## Running the Workspace

### Initial Setup

Install dependencies first (from the repository root):

```bash
# From the repository root
bun install
```

### Option 1: Automated Tests

Run the automated test suite to see the workspace in action:

```bash
# From this directory
bun test

# Or from the repository root
bun test examples/basic-workspace
```

The tests demonstrate:
1. YJS persistence across multiple sessions
2. Bidirectional markdown file sync
3. CRUD operations (create, read, update)
4. Index synchronization

### Option 2: CLI Commands

Use the Epicenter CLI to interact with the workspace:

```bash
# From this directory
bun cli.ts

# Create a new post
bun cli.ts blog createPost --title "My First Post" --content "Hello World" --category tech

# Publish a post (you'll need the ID from the previous command)
bun cli.ts blog publishPost --id <post-id>

# Add a comment
bun cli.ts blog addComment --postId <post-id> --author "Alice" --content "Great post!"

# Increment views
bun cli.ts blog incrementViews --id <post-id>

# Query published posts
bun cli.ts blog getPublishedPosts

# Get a specific post
bun cli.ts blog getPost --id <post-id>

# Get comments for a post
bun cli.ts blog getPostComments --postId <post-id>
```

### CLI Help

Get help for any action:

```bash
# See all available workspaces and actions
bun cli.ts --help

# Get help for a specific action
bun cli.ts blog createPost --help
```

## Working with Markdown Files

The markdown index creates human-readable files in `.data/content/`:

```
.data/content/
├── posts/
│   └── <post-id>.md
└── comments/
    └── <comment-id>.md
```

### Example Post File

```markdown
---
id: abc123
title: My First Post
content: Hello World
category: tech
views: 5
publishedAt: "2024-01-15T10:30:00.000Z"
---
```

### Editing Markdown Files

You can edit these files directly:
1. Open a `.md` file in your text editor
2. Modify the YAML frontmatter
3. Save the file
4. Changes automatically sync back to the workspace

This makes your data:
- **Git-friendly**: Easy to diff, merge, and version control
- **Human-readable**: No special tools needed to view or edit
- **Portable**: Just plain text files

## Key Concepts Demonstrated

1. **YJS Document**: The source of truth for all data (CRDT for collaboration)
2. **YJS Persistence**: Binary `.yjs` file in `.epicenter/` persists state across sessions
3. **Table Schemas**: Define column structure with pure JSON
4. **Indexes**:
   - SQLite for querying
   - Markdown for git-friendly persistence
5. **Actions**: Business logic with access to tables (write) and indexes (read)
6. **CLI**: Auto-generated command-line interface from workspace actions
7. **Bidirectional Sync**: Edit data through the app or markdown files

## Data Flow

### Writes (Through Actions or Tables)
```typescript
// Through action
await blog.createPost({ title: 'Hello', content: 'World', category: 'tech' });

// Through table helper
db.posts.insert({ id: '1', title: 'Hello', /* ... */ });

// Result: YJS updated → Saved to .epicenter/blog.yjs → SQLite synced → Markdown file created
```

### Reads (Through Queries)
```typescript
// Query the SQLite index
const { data } = await blog.getPublishedPosts();

// Result: Fast queries from SQLite snapshot
```

### Manual Edits (Through Markdown Files)
```bash
# Edit a markdown file
vim .data/content/posts/abc123.md

# Result: File watcher detects change → YJS updated → Saved to .yjs → SQLite synced
```

### Persistence Across Sessions
```bash
# Session 1: Create a post
bun cli.ts blog createPost --title "My Post" --category tech
# YJS state saved to .epicenter/blog.yjs

# Session 2: Query the post (it persists!)
bun cli.ts blog getPublishedPosts
# YJS state loaded from .epicenter/blog.yjs

# Session 3: Update views (works across sessions!)
bun cli.ts blog incrementViews --id <post-id>
# Changes saved back to .epicenter/blog.yjs
```

## Testing Your Changes

1. **Run the automated tests**:
   ```bash
   bun test
   ```

2. **Use the CLI to create data**:
   ```bash
   bun cli.ts blog createPost --title "CLI Test" --category personal
   ```

3. **Check the markdown files**:
   ```bash
   ls .data/content/posts/
   cat .data/content/posts/<post-id>.md
   ```

4. **Edit a markdown file manually** and verify the changes sync back (or run the bidirectional-sync test)
