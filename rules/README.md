# Rules Organization

This directory contains guidelines for AI assistants working on this codebase. Content is organized to support lazy loading: load only what's needed for the specific task at hand.

## Structure

### Core Guidelines (Always Loaded)

**@rules/general-guidelines.md** - Loaded immediately for all tasks. Contains:

- Standard Workflow
- Expensive/destructive actions
- Honesty principle
- Human-Readable Control Flow

These principles apply across all development tasks regardless of domain.

### Domain-Specific Guidelines (Load on Demand)

Load these only when working in their specific domains:

**Language & Framework**

- `@rules/typescript.md` - TypeScript rules, type co-location principles
- `@rules/svelte.md` - Svelte patterns, TanStack Query mutations, component composition
- `@rules/rust.md` - Rust to TypeScript error handling patterns (Tauri)

**Development Practices**

- `@rules/error-handling.md` - wellcrafted trySync/tryAsync patterns
- `@rules/styling.md` - General CSS and Tailwind best practices

**Tools & Workflows**

- `@rules/git.md` - Commit messages, PR guidelines, conventional commits
- `@rules/github.md` - Issue responses, community interaction patterns
- `@rules/posthog.md` - Analytics integration patterns

**Content & Communication**

- `@rules/documentation.md` - Technical writing, README guidelines, punctuation
- `@rules/social-media.md` - LinkedIn, Reddit, Twitter post guidelines

## Usage

When the AI assistant encounters a file reference like `@rules/typescript.md`, it should:

1. Use the Read tool to load the file only when needed
2. Treat the content as mandatory instructions
3. Follow references recursively if needed
4. Not preemptively load all files

This lazy loading approach keeps context focused and token usage efficient.

## Git Worktree Note

Each git worktree (`.conductor/` branch) has its own copy of these rules since they're committed to the repo. When updating rules:

- Make changes in your working branch
- If the change should apply globally, merge to main and rebase other branches
- Accept that experimental branches may temporarily have different rules
