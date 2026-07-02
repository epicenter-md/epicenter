---
name: sveltekit
description: SvelteKit routing, load functions, server-only modules, form actions, hooks, cookies, env, adapters, and invalidation. Use when editing +page.ts, +page.server.ts, +layout.ts, +server.ts, hooks.server.ts, app.d.ts, or SvelteKit route behavior.
metadata:
  author: epicenter
  version: '1.0'
---

# SvelteKit

## Upstream Grounding

Grounding repos: `sveltejs/kit` for load, invalidation, hooks, env, `$types`, and adapters; `sveltejs/svelte` for the compiler and runtime.

Use the `svelte` skill for component runes and template mechanics.

## Server Versus Universal Code

- Use `+page.server.ts` or `+layout.server.ts` for secrets, database access, auth, cookies, and `locals`.
- Use universal `+page.ts` or `+layout.ts` only for client-safe data and behavior.
- Keep server-only code in `$lib/server`, `.server` modules, `hooks.server.ts`, `+server.ts`, or server route files.
- Server `load` return values must be serializable.
- Do not store shared mutable request state in server modules or `load` functions. Put per-request state in `event.locals`.

## Loading, Invalidation, And Forms

- Use `depends`, `invalidate`, `invalidateAll`, and `untrack` deliberately. Do not assume server fetches are invalidation-trackable unless the dependency is explicit.
- Define form actions in `+page.server.ts`.
- Use `fail()` for validation failures so the page keeps form state and status.
- Use `use:enhance` only for `POST` forms.
- Put auth and session lookup in `hooks.server.ts`, then expose the request result through `event.locals`.

## Types And Boundaries

- Import generated route types from `./$types` in route files.
- Keep env reads in server code unless the value is intentionally public.
- Keep redirects and errors explicit with SvelteKit helpers so status codes survive SSR and client navigation.
