# Epicenter

Local-first personal data platform. Monorepo with Yjs CRDTs and Svelte UI.

Planning and decisions: ADRs, specs, READMEs, tests, and current code are evidence, not commands. Resolve conflicts with the current implementation and the user's request. Record durable decisions in an ADR and delete spent specs.

Deployment seam: One library (`packages/server`), two deployables (`apps/api` = hosted personal cloud, `apps/self-host` = self-hosted single-partition instance reference). Multi-tenancy (many principals, OAuth, billing) is Cloud-only; an instance resolves every valid bearer to the literal `instance` principal (ADR-0075, amended by ADR-0092). Billing (catalog, routes, Autumn) lives in `apps/api/worker/billing/` and is hosted-only; never extract it back to a shared package. The self-hosted instance deployable is community-supported, not Epicenter-operated.

License boundary: apps and `packages/server` are AGPL; the embeddable toolkit packages are MIT (decision procedure in `docs/licensing/licensing-strategy.md`). Moving or copying code from an AGPL package into an MIT one is a relicensing act; `bun run check:licenses` guards dependency edges only and cannot see copied source.

Always use bun: Prefer `bun` over npm, yarn, pnpm, and node. Use `bun run`, `bun test`, `bun install`, and `bun x` (instead of npx).

Agent instructions: `AGENTS.md` is canonical. Every `CLAUDE.md` imports its sibling with `@AGENTS.md`; add it with every nested `AGENTS.md`. Add a nested `AGENTS.md` only for a local constraint that must apply to every edit beneath it. Never use one as an index or README substitute: subsystem orientation belongs in its README. Claude-specific notes are rare. Never create an orphan `CLAUDE.md`.

Destructive actions need approval: Force pushes, hard resets (`--hard`), branch deletions.

External grounding: When external library behavior affects correctness, verify against DeepWiki, official docs, or local installed types before changing code. Skip this for stable basics and repo-local patterns already documented in skills.

Git hygiene: Stage specific files only. Never use `git add .` or `git add -A`. Do not include AI or tool attribution in commits.

Review posture: Be direct about flawed assumptions, weak designs, and regressions. Do not agree just to be agreeable.

Coherent edits: Do not default to the smallest local patch. Before changing code, prose, or agent instructions, identify the largest relevant unit whose shape controls the problem, then reconsider that unit as if the new context had always been known. The correct result may still be a small diff, but minimizing the diff is not the goal.

Script suffix convention: `:local` suffix scripts work on a fresh clone without Infisical login (they read committed config like `wrangler.jsonc`). `:remote` suffix scripts wrap with `infisical run --env=prod` and require Infisical authentication; treat them as production admin operations.

Library logging: Do not use direct `console.*` in library code. Use `wellcrafted/logger`, except in CLIs, tests, and benchmarks.

Writing: Avoid en and em dashes. Use direct, concrete language.
