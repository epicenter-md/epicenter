# Epicenter CLI

Manage workspace data and start the sync server.

## Command Structure

```bash
epicenter <table> <action>  # table operations (e.g., posts list)
epicenter kv <action>       # key-value operations
epicenter tables            # list table names
epicenter serve             # start HTTP/WebSocket server
```

## Table Commands

```bash
epicenter users list              # list all rows
epicenter users list --all        # include invalid rows
epicenter users get <id>          # get row by id
epicenter users set '<json>'      # create/replace row
epicenter users update <id> --name "New"  # partial update
epicenter users delete <id>       # delete row
epicenter users clear             # delete all rows
epicenter users count             # count rows
```

## KV Commands

```bash
epicenter kv get <key>            # get value
epicenter kv set <key> <value>    # set value
epicenter kv delete <key>         # delete key
```

## Input Methods

```bash
# Inline JSON
epicenter users set '{"id":"1","name":"Alice"}'

# From file
epicenter users set --file user.json
epicenter users set @user.json

# From stdin
cat user.json | epicenter users set

# Flag-based update
epicenter users update abc123 --name "Bob" --active true
```

## Output Formats

```bash
epicenter users list                  # pretty JSON (TTY)
epicenter users list | jq             # compact JSON (pipe)
epicenter users list --format json    # force JSON
epicenter users list --format jsonl   # JSON lines
```

## Server

```bash
epicenter serve              # default port 3913
epicenter serve --port 8080  # custom port
```

Exposes REST API and WebSocket sync.

## Working Directory

By default, Epicenter looks for `epicenter.config.ts` in the current directory.

Use `-C` or `--dir` to run from a different directory:

```bash
epicenter -C apps/blog posts list
epicenter --dir apps/shop products get abc123
```

If no config is found in the current directory but configs exist in subdirectories, Epicenter shows a helpful message:

```
No epicenter.config.ts found in current directory.

Found configs in subdirectories:
  - apps/blog/epicenter.config.ts
  - apps/shop/epicenter.config.ts

Use -C <dir> to specify which project:
  epicenter -C apps/blog <command>
```

## Multiple Workspaces

For multiple workspaces, use separate directories with their own `epicenter.config.ts` files.
