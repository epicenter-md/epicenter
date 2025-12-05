# Markdown Index

The Markdown Index provides bidirectional synchronization between your YJS documents and markdown files on disk. This enables git-friendly workflows where you can edit data either through your application or by directly editing markdown files.

## What It Does

The Markdown Index keeps your YJS database and markdown files in sync. When you add, update, or delete records in your database, those changes are automatically written to markdown files. When you edit markdown files directly (for example, in your text editor or through git operations), those changes flow back into the database.

## Why Use It

Traditional databases store data in binary formats that don't work well with version control systems like git. The Markdown Index solves this by storing each record as a human-readable markdown file with YAML frontmatter. This gives you:

- **Git-friendly storage**: Markdown files can be diffed, merged, and versioned
- **Direct editing**: Edit your data in any text editor
- **Human readability**: No need for special tools to view or modify your data
- **Backup simplicity**: Your data is just files on disk

## How It Works

### Markdown File Format

Each database record becomes a markdown file:

```markdown
---
id: abc123
title: My Blog Post
published: true
tags:
  - typescript
  - database
---

This is the body of my blog post. Everything after the frontmatter
becomes the "body" field.
```

The YAML frontmatter contains your structured data, and anything after the `---` delimiter is stored as the markdown body.

### File Organization

Files are organized by table name:

```
storage/
  posts/
    abc123.md
    def456.md
  authors/
    john-doe.md
    jane-smith.md
```

Each table gets its own directory, and each record becomes a file named after its ID.

### Bidirectional Sync

The index watches for changes in both directions:

**Database → Files**: When you insert, update, or delete records through your application, the corresponding markdown files are automatically created, updated, or deleted.

**Files → Database**: When you edit, create, or delete markdown files directly (using a text editor, git operations, or any other tool), those changes are detected and synchronized back to the database.

### Data Type Handling

Different column types are handled appropriately:

- **Text fields**: Stored as plain strings in YAML
- **Numbers**: Stored as YAML numbers (no quotes)
- **Booleans**: Stored as YAML booleans (`true`/`false`)
- **Multi-select fields**: Stored as YAML arrays
- **Rich text**: Converted to plain strings (Y.Text becomes string)

### Granular Updates

When syncing changes from markdown files back to the database, the index uses granular diff algorithms instead of replacing entire values. This preserves the collaborative editing properties of YJS CRDTs and minimizes conflicts in multi-user scenarios.

For text fields, character-level diffs are computed. For array fields like multi-select, element-level diffs are computed. This means if you change a single character or add a single tag, only that specific change is applied rather than replacing the entire field.

## Configuration

The Markdown Index uses a two-layer configuration structure that determines where files are stored and how data is serialized.

### Configuration Layers

```
MarkdownIndexConfig
├── directory (workspace-level)
│   └── Defaults to workspace ID
│
└── tableConfigs
    ├── posts
    │   ├── directory (table-level)
    │   │   └── Defaults to table name
    │   ├── serialize()
    │   │   └── Converts row → { frontmatter, body, filename }
    │   └── deserialize()
    │       └── Converts { frontmatter, body, filename } → row
    │
    └── authors
        ├── directory (table-level)
        ├── serialize()
        └── deserialize()
```

### File Naming

Index artifacts (logs, diagnostics) use the **index ID** from your workspace config:

```typescript
// Single markdown index
indexes: {
  markdown: (c) => markdownIndex(c, { directory: './docs' }),
}
// Files: .epicenter/blog/markdown.log, .epicenter/blog/markdown.diagnostics.json

// Multiple markdown indexes
indexes: {
  markdownDocs: (c) => markdownIndex(c, { directory: './docs' }),
  markdownObsidian: (c) => markdownIndex(c, { directory: '/path/to/vault' }),
}
// Files: .epicenter/blog/markdownDocs.log, .epicenter/blog/markdownObsidian.log
```

The index ID (`markdown`, `markdownDocs`, etc.) is automatically passed via `context.indexId`.

### Layer 1: Workspace Configuration

**`directory`** (optional): The workspace-level directory where all markdown files for this workspace are stored.
- Defaults to the workspace `id`
- Can be a relative path (resolved from `storageDir`) or absolute path
- Example: If workspace id is "blog", defaults to `<storageDir>/blog`

**`tableConfigs`** (optional): Per-table configuration object where keys are table names and values define how each table is handled.

### Layer 2: Table Configuration

Each table in `tableConfigs` can have these properties:

**`directory`** (optional): The directory for this specific table's markdown files.
- Defaults to the table name
- Resolved relative to the workspace directory (unless absolute)

**`serialize()`**: Converts a database row into markdown format.
- Input: `{ row, table }`
- Output: `{ frontmatter, body, filename }`

**`deserialize()`**: Converts markdown back into a database row.
- Input: `{ frontmatter, body, filename, table }`
- Output: `Result<SerializedRow, MarkdownIndexError>`

### Directory Resolution Example

With default configuration:

```
storageDir/
└── blog/                    (workspace.id = "blog")
    ├── posts/               (table name = "posts")
    │   ├── post-1.md
    │   └── post-2.md
    └── authors/             (table name = "authors")
        ├── john.md
        └── jane.md
```

With custom paths:

```
storageDir/
└── content/                 (workspace.directory = "./content")
    ├── blog-posts/          (posts.directory = "./blog-posts")
    │   ├── post-1.md
    │   └── post-2.md
    └── team/                (authors.directory = "./team")
        ├── john.md
        └── jane.md
```

### Default Behavior

When you don't provide custom configuration:

- **Workspace directory**: Same as workspace `id`
- **Table directory**: Same as table name
- **Serialize**: All row fields (except `id`) → frontmatter, empty body, filename = `{id}.md`
- **Deserialize**: Extract `id` from filename, validate frontmatter against schema

```
storageDir/
└── {workspace.id}/
    └── {tableName}/
        └── {rowId}.md
```

## Usage

### Setup

Create a markdown index when defining your workspace. The `markdownIndex` is highly configurable but works with sensible defaults.

#### Minimal Setup (Recommended)

If you're happy with the defaults, you can simply pass `markdownIndex`:

```typescript
import { defineWorkspace, markdownIndex } from 'epicenter';

const workspace = defineWorkspace({
	id: 'blog',
	schema: {
		posts: {
			id: id(),
			title: text(),
			content: text({ nullable: true }),
			tags: tags({ options: ['tech', 'design', 'product'] }),
			published: boolean({ default: false }),
		},
	},

	indexes: {
		markdown: markdownIndex, // Uses all defaults!
	},
});
```

With this setup:

- Storage path defaults to `./blog` (the workspace `id`)
- File structure is `{tableName}/{id}.md`
- All fields are stored in YAML frontmatter

#### Explicit Setup

You can also write it out explicitly if you prefer:

```typescript
indexes: {
	markdown: (context) => markdownIndex(context);
}
```

#### Custom Storage Directory

To store files in a different location (relative to storageDir):

```typescript
indexes: {
  markdown: (context) => markdownIndex(context, {
    directory: './vault',  // → <storageDir>/vault
  }),
}
```

Or use an absolute path:

```typescript
indexes: {
  markdown: (context) => markdownIndex(context, {
    directory: '/absolute/path/to/vault',
  }),
}
```

#### Custom Serializers

Use custom serializers when you want to control how your data is stored in markdown files. This is useful when:

- **Moving fields to the markdown body**: Put a field (like `content`) in the markdown body instead of frontmatter
- **Combining multiple fields**: Merge multiple fields into the markdown body (e.g., title as a header + body)

**Example 1: Basic body in markdown body**

```typescript
indexes: {
  markdown: (context) => markdownIndex(context, {
    tableConfigs: {
      posts: {
        serialize: ({ row }) => ({
          frontmatter: { tags: row.tags, published: row.published },
          body: row.content || '',
          filename: `${row.id}.md`
        }),
        deserialize: ({ frontmatter, body, filename, table }) => {
          const id = path.basename(filename, '.md');

          // Validate frontmatter using schema
          const FrontMatter = table.validators.toArktype().omit('id', 'content');
          const frontmatterParsed = FrontMatter(frontmatter);

          if (frontmatterParsed instanceof type.errors) {
            return MarkdownIndexErr({
              message: `Invalid frontmatter for post ${id}`,
              context: { filename, id, reason: frontmatterParsed },
            });
          }

          const row = {
            id,
            content: body,
            ...frontmatterParsed,
          } satisfies SerializedRow<typeof table.schema>;

          return Ok(row);
        }
      }
    }
  }),
}
```

**Example 2: Combining title + body in markdown body**

This creates more natural-looking markdown files where the title is a header:

```typescript
indexes: {
  markdown: (context) => markdownIndex(context, {
    tableConfigs: {
      posts: {
        serialize: ({ row }) => ({
          frontmatter: { tags: row.tags, published: row.published },
          body: `# ${row.title}\n\n${row.content || ''}`,
          filename: `${row.id}.md`
        }),
        deserialize: ({ frontmatter, body, filename, table }) => {
          const id = path.basename(filename, '.md');

          // Extract title from first line (# Title format)
          const lines = body.split('\n');
          const title = lines[0]?.replace(/^#\s*/, '') || '';
          const bodyContent = lines.slice(2).join('\n'); // Skip title and empty line

          // Validate frontmatter using schema
          const FrontMatter = table.validators.toArktype().omit('id', 'title', 'content');
          const frontmatterParsed = FrontMatter(frontmatter);

          if (frontmatterParsed instanceof type.errors) {
            return MarkdownIndexErr({
              message: `Invalid frontmatter for post ${id}`,
              context: { filename, id, reason: frontmatterParsed },
            });
          }

          const row = {
            id,
            title,
            content: bodyContent,
            ...frontmatterParsed,
          } satisfies SerializedRow<typeof table.schema>;

          return Ok(row);
        }
      }
    }
  }),
}
```

This produces markdown files like:

```markdown
---
tags: [tech, typescript]
published: true
---

# My Blog Post Title

This is the actual content of my blog post...
```

#### Full Configuration

For complete control over file structure and serialization:

```typescript
indexes: {
  markdown: (context) => markdownIndex(context, {
    directory: './content',  // Custom workspace directory
    tableConfigs: {
      posts: {
        directory: './blog-posts',  // Custom table directory
        serialize: ({ row }) => ({
          frontmatter: { title: row.title, tags: row.tags },
          body: row.content || '',
          filename: `${row.id}.md`
        }),
        deserialize: ({ frontmatter, body, filename, table }) => {
          const id = path.basename(filename, '.md');

          // Validate frontmatter using schema
          const FrontMatter = table.validators.toArktype().omit('id', 'content');
          const frontmatterParsed = FrontMatter(frontmatter);

          if (frontmatterParsed instanceof type.errors) {
            return MarkdownIndexErr({
              message: `Invalid frontmatter for post ${id}`,
              context: { filename, id, reason: frontmatterParsed },
            });
          }

          const row = {
            id,
            content: body,
            ...frontmatterParsed,
          } satisfies SerializedRow<typeof table.schema>;

          return Ok(row);
        }
      }
    }
  }),
}
```

### Working with Data

Once configured, you can work with your data in two ways:

**Through the application**:

```typescript
// Insert a post (markdown file created automatically)
db.tables.posts.insert({
	id: 'hello-world',
	title: 'Hello World',
	content: 'My first post',
	tags: ['tech'],
	published: true,
});

// Update a post (markdown file updated automatically)
db.tables.posts.update({
	id: 'hello-world',
	published: true,
});
```

**By editing markdown files directly**:

Edit `content/posts/hello-world.md`:

```markdown
---
id: hello-world
title: Hello World (Updated)
content: My first post
tags:
  - tech
  - design
published: true
---
```

Save the file, and the changes automatically sync to your database.

## Loop Prevention

The index prevents infinite loops between file changes and database changes using simple flag-based guards. When processing a database change, file watch events are ignored. When processing a file change, database observers are ignored. This ensures changes only propagate in one direction at a time.

## Error Handling

Parse and validation errors are handled gracefully:

- **Invalid YAML**: Errors are logged, the file is skipped, and the system continues running
- **Schema mismatches**: If a markdown file doesn't match your table schema, an error is logged and the file is skipped
- **File system errors**: Missing directories are created automatically, and file deletion failures are treated as warnings

The system is designed to be resilient to errors in individual files rather than crashing the entire application.

## Limitations

- **Y.XmlFragment fields**: Currently not supported (future enhancement)
- **File watcher noise**: File systems can generate multiple events for a single change, but the index handles this gracefully through idempotent operations
- **Large files**: Each record becomes its own file, which works well for most use cases but may not be ideal for extremely large datasets

## When to Use

The Markdown Index is ideal when:

- You want git-friendly storage for your data
- You want to edit records directly in a text editor
- You're building a content-focused application (blog, documentation site, notes app)
- You need human-readable backups of your data

Consider alternatives when:

- You need high-performance writes for large datasets
- Your data is primarily binary or doesn't map well to markdown
- You don't need the git/direct-editing benefits
