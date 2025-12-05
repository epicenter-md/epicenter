# Silent Failure Pattern in Bash

You might see this pattern in shell scripts:

```bash
some_command 2>/dev/null || true
```

Here's what each part does:

## `2>/dev/null`

- `2` is stderr (standard error output)
- `>` redirects it
- `/dev/null` is a black hole that discards anything sent to it

This suppresses error messages.

## `|| true`

- `||` means "if the previous command failed, run this"
- `true` is a command that always succeeds (exit code 0)

This ensures the overall expression always succeeds.

## When to Use It

Use this for optional operations that shouldn't fail your script. For example, symlinking an optional `.env` file:

```bash
ln -sf "$CONDUCTOR_ROOT_PATH/examples/content-hub/.env" examples/content-hub/.env 2>/dev/null || true
```

If the source `.env` doesn't exist:
- Without the pattern: symlink fails → script exits with error
- With the pattern: symlink silently skipped → script continues

## Real Example

In a setup script where `.env` is optional:

```json
{
  "scripts": {
    "setup": "bun install && ln -sf \"$CONDUCTOR_ROOT_PATH/examples/content-hub/.env\" examples/content-hub/.env 2>/dev/null || true"
  }
}
```

The `bun install` must succeed, but the symlink is best-effort. If someone hasn't created their `.env` yet, setup still completes successfully.

## When NOT to Use It

Don't use this for operations that must succeed. If a failure should stop the script, let it fail naturally:

```bash
# This SHOULD fail if the database isn't reachable
./scripts/migrate-db.sh
```
