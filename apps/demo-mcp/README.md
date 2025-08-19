# Demo MCP App

POC for Reddit Adapter. It imports Reddit data into a libSQL file and demonstrates MCP (Model Context Protocol) integration with Claude Code.

## Data Import

Import your Reddit data export:

```bash
bun run apps/demo-mcp/src/cli.ts import reddit --file ./export_username_date.zip
```

This creates a SQLite database at `.data/reddit.db` with your Reddit posts, comments, and other data.

## Plaintext export/import (Markdown)

Export database rows to deterministic plaintext files under `vault/<adapter>/...` using Markdown (with frontmatter):

```bash
bun run apps/demo-mcp/src/cli.ts export-fs reddit --db ./.data/reddit.db --repo .
```

Import files from the repo back into the database:

```bash
bun run apps/demo-mcp/src/cli.ts import-fs reddit --db ./.data/reddit.db --repo .
```

Notes:

- Files are Markdown only, written under `vault/<adapter>/<table>/<pk...>.md`.

## Try it

1) Import your Reddit export into a local DB

```bash
bun run apps/demo-mcp/src/cli.ts import reddit --file ./export_username_date.zip --db ./.data/reddit.db
```

2) Export DB rows to Markdown files in your repo

```bash
bun run apps/demo-mcp/src/cli.ts export-fs reddit --db ./.data/reddit.db --repo .
```

You should see Markdown files under `vault/reddit/<table>/...`. To re-import from files into the DB:

```bash
bun run apps/demo-mcp/src/cli.ts import-fs reddit --db ./.data/reddit.db --repo .
```

### CLI usage

```bash
bun run apps/demo-mcp/src/cli.ts --help
# or
bun run apps/demo-mcp/src/cli.ts help
```

## MCP Integration with Claude Code

Once you have imported your data, you can connect the database to Claude Code for natural language querying.

### Quick Setup

1. **Add the MCP server** to Claude Code:

   ```bash
   claude mcp add turso-reddit -- tursodb ./.data/reddit.db --mcp
   ```

2. **Restart Claude Code** to activate the connection

3. **Start querying** your Reddit data with natural language!

### What You Can Ask Claude Code

Once connected, try these example queries:

#### Database Structure

- "Show me all tables in the database"
- "What's the schema for the posts table?"
- "Describe the structure of the comments table"

#### Data Exploration

- "How many posts do I have in the database?"
- "Show me my most recent 10 posts"
- "Find my posts with the highest scores"
- "What subreddits do I post in most?"

#### Data Analysis

- "What's the average score of my posts?"
- "Which of my posts got the most comments?"
- "Show me my posting activity over time"
- "Find posts I made about specific topics"

### Command Breakdown

```bash
claude mcp add turso-reddit -- tursodb ./.data/reddit.db --mcp
#              ↑             ↑       ↑               ↑
#              |             |       |               |
#              Server name   |       Database path   MCP mode
#                           Separator
```

- **`turso-reddit`** - Name for this MCP server
- **`--`** - Required separator between Claude options and command
- **`tursodb`** - The Turso database CLI
- **`./.data/reddit.db`** - Path to your imported Reddit database
- **`--mcp`** - Enables MCP server mode

### Managing the MCP Server

```bash
# List all configured MCP servers
claude mcp list

# Get details about this server
claude mcp get turso-reddit

# Remove the server
claude mcp remove turso-reddit
```
