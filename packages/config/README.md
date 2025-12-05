# @epicenter/config

Shared configuration files for Svelte applications in the Whispering monorepo.

## Purpose

While the monorepo uses Biome for general TypeScript/JavaScript formatting and linting at the root level, Svelte applications require additional tooling:

- **ESLint**: Provides Svelte-specific linting rules and plugins that Biome doesn't support
- **Prettier**: Handles Svelte component formatting through the prettier-plugin-svelte

This package centralizes these Svelte-specific configurations to ensure consistency across all Svelte projects in the monorepo.

## Installation

```bash
# Add the config package and the tool binaries
bun add -D @epicenter/config eslint prettier
```

The config package includes all the necessary plugins and configurations as dependencies, so you only need to install the main ESLint and Prettier binaries.

## ESLint Configuration

```js
// eslint.config.js
import { base, svelteConfig } from "@epicenter/config/eslint";

export default [...base, ...svelteConfig];
```

## Prettier Configuration

```ts
// prettier.config.ts
import { prettierConfig } from "@epicenter/config/prettier";

export default prettierConfig;
```
