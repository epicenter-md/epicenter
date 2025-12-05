# Shared Root TSConfig Migration

1. Context and Goals

- Why a shared root config
  - Reduce duplication across apps and packages while keeping framework specifics local
  - Establish safe, modern TypeScript defaults that match our bundlers and target runtimes
- Goals
  - Consistency: same baseline flags across the monorepo; fewer surprises
  - Less repetition: common compilerOptions live once in [tsconfig.base.json](tsconfig.base.json)
  - Safer defaults: strictness flags enabled by default without breaking framework presets

2. Guiding Principles

- Keep the root config framework-agnostic; Svelte, Astro, and Workers keep their types and special flags in local configs
- Allow per-app overrides; anything can be overridden in local tsconfig files
- Avoid breaking established framework presets; never override framework-required options in the root

3. Monorepo Import Strategy

- Per-app absolute imports:
  - Svelte apps: define "$lib/\*" locally; example in app tsconfig and Vite config; do not add this at root
  - Astro apps: define a project-local alias via Vite config and local tsconfig
  - Node or CLI packages: optionally use "~/\*" pointing to "src"; define locally only

7. Extends Array Adoption Strategy

- For projects that currently use a single "extends" value
  - Change "extends" to an array with the root base first, then the existing preset or path

```json
{
	"extends": ["../../tsconfig.base.json", "existing-preset-or-path"],
	"compilerOptions": {
		// local overrides
	}
}
```

- For projects that already use an "extends" array
  - Prepend the root base as the first entry; preserve the existing order
- For Svelte and Astro apps
  - Keep framework "types" and any required flags in the local tsconfig; do not rely on the root for framework specifics
- For Cloudflare Workers
  - Keep worker-specific "lib" and platform settings locally; e.g., "lib": ["ES2022", "WebWorker", "DOM"]
