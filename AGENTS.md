# Epicenter

Local-first workspace platform. Monorepo with Yjs CRDTs, Tauri desktop app, and Svelte UI.

**Structure**: `apps/epicenter/` (Tauri app), `packages/epicenter/` (core TypeScript/Yjs library), `packages/ui/` (shadcn-svelte components), `specs/` (planning docs), `docs/` (reference materials).

**Always use bun**: Prefer `bun` over npm, yarn, pnpm, and node. Use `bun run`, `bun test`, `bun install`, and `bun x` (instead of npx).

**Skills**: Task-specific instructions live in `.claude/skills/`. Load on-demand based on the task.

**Destructive actions need approval**: Force pushes, hard resets (`--hard`), branch deletions.

**Token-efficient execution**: For expensive operations (tests, builds, commits), delegate to sub-agent with only the command. Instruct it to execute without re-analyzing.

**Git worktrees**: When in `.conductor/` directories, all file operations must use that worktree path, not the parent repo.
