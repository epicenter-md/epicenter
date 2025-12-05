# Content Hub Scripts

Utility scripts for programmatically transforming markdown files in your Epicenter workspace. These scripts use the Epicenter client to parse and modify frontmatter in bulk.

## Setup

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and set your markdown directory path:
   ```bash
   MARKDOWN_SOURCE_PATH=/path/to/your/markdown/files
   ```

## Overview

These scripts were created to handle common markdown transformation tasks:

1. **01-normalize-markdown.ts**: Standardizes YAML frontmatter formatting
2. **02-transform-dates.ts**: Consolidates timezone information into date fields

The numbered prefix indicates the recommended order of operations. Run normalize first to ensure consistent YAML formatting before doing any transformations.

## Scripts

### 01-normalize-markdown.ts

**Purpose**: Standardizes YAML frontmatter formatting across all markdown files.

**What it does**:
- Recursively scans a directory for `.md` files
- Parses each file's frontmatter using Epicenter's `readMarkdownFile`
- Re-serializes frontmatter using `Bun.YAML.stringify` with consistent formatting (2-space indent)
- Writes files back with standardized YAML structure

**Why run this first**: Different editors and tools format YAML differently. Normalizing first ensures all subsequent transformations work with consistent formatting, making diffs cleaner and transformations more predictable.

**Primitives used**:
- `listMarkdownFiles` from `@epicenter/hq/indexes/markdown` - recursively finds all .md files
- `readMarkdownFile` from `@epicenter/hq/indexes/markdown` - parses markdown with frontmatter
- `writeMarkdownFile` from `@epicenter/hq/indexes/markdown` - writes markdown with YAML frontmatter

**Usage**:
```bash
# Dry run to preview changes
bun scripts/01-normalize-markdown.ts --dry-run

# Apply changes
bun scripts/01-normalize-markdown.ts
```

### 02-transform-dates.ts

**Purpose**: Consolidates timezone information into date fields using pipe notation.

**What it does**:
- Scans for markdown files with a `timezone` or `timeZone` frontmatter field
- Appends timezone to `date`, `created_at`, and `updated_at` fields using pipe operator
  - Example: `2024-01-15T10:30:00` becomes `2024-01-15T10:30:00|America/Los_Angeles`
- Removes the standalone timezone field after consolidation
- Re-serializes and writes back

**Why this transformation**: Instead of storing timezone separately, this embeds it directly in the date fields using a pipe delimiter. This makes date fields self-describing and eliminates the need for a separate timezone field.

**Primitives used**:
- `listMarkdownFiles` from `@epicenter/hq/indexes/markdown` - recursively finds all .md files
- `readMarkdownFile` from `@epicenter/hq/indexes/markdown` - parses markdown with frontmatter
- `writeMarkdownFile` from `@epicenter/hq/indexes/markdown` - writes markdown with YAML frontmatter
- String concatenation with pipe operator for date transformation
- `delete` operator to remove obsolete fields

**Usage**:
```bash
# Dry run to preview changes
bun scripts/02-transform-dates.ts --dry-run

# Apply changes
bun scripts/02-transform-dates.ts
```

## Recommended Workflow

When transforming markdown files in bulk:

1. **Normalize first**: Run `01-normalize-markdown.ts` to standardize YAML formatting
   ```bash
   bun scripts/01-normalize-markdown.ts --dry-run
   bun scripts/01-normalize-markdown.ts
   ```

2. **Transform dates**: Run `02-transform-dates.ts` to consolidate timezone info
   ```bash
   bun scripts/02-transform-dates.ts --dry-run
   bun scripts/02-transform-dates.ts
   ```

3. **Review changes**: Use `git diff` to inspect what changed before committing

## Creating Your Own Scripts

These scripts follow a common pattern you can reuse:

```typescript
import {
	listMarkdownFiles,
	readMarkdownFile,
	writeMarkdownFile,
} from '@epicenter/hq/indexes/markdown';

const sourcePath = process.env.MARKDOWN_SOURCE_PATH;
if (!sourcePath) {
	console.error('❌ Error: MARKDOWN_SOURCE_PATH not set in .env file');
	process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

// Find all markdown files recursively
const markdownFiles = await listMarkdownFiles(sourcePath);

// Process each file
await Promise.all(
	markdownFiles.map(async (filePath) => {
		// Read the file
		const readResult = await readMarkdownFile(filePath);
		if (readResult.error) {
			// Handle error
			return;
		}

		const { data: frontmatter, body } = readResult.data;

		// Transform frontmatter here
		// ... your logic ...

		// Write back
		if (!dryRun) {
			const writeResult = await writeMarkdownFile({
				filePath,
				frontmatter,
				body,
			});

			if (writeResult.error) {
				// Handle error
				return;
			}
		}
	}),
);
```

## Key Primitives

All markdown operations are available from `@epicenter/hq/indexes/markdown`:

- **listMarkdownFiles(sourcePath)**: Recursively finds all .md files, returns `AbsolutePath[]`
- **readMarkdownFile(filePath)**: Parses markdown with frontmatter, returns `Result<{ data: object, body: string }>`
- **writeMarkdownFile({ filePath, frontmatter, body })**: Writes markdown with YAML frontmatter, returns `Result<void>`
- **deleteMarkdownFile({ filePath })**: Deletes a markdown file, returns `Result<void>`

## Safety Features

All scripts include:
- **Dry run mode**: Preview changes with `--dry-run` flag
- **Error tracking**: Failed files are collected and reported
- **Stats reporting**: Clear summary of what was processed, modified, skipped, or errored
- **Parallel processing**: Uses `Promise.all` for fast bulk operations
