# JSDoc File Annotations

In Epicenter, we use JSDoc `@fileoverview` annotations per file. We do this instead of documenting every file in a README because it co-locates the description with the code.

This follows a general philosophy: READMEs shouldn't list files, just like PRs shouldn't list changes (see [The README Problem I Kept Running Into](./why-not-what-readmes.md)). It's self-evident. You can `ls` the files in a folder. You can see the files changed in a PR diff. Duplicating that in prose just creates maintenance burden.

But file annotations are different. They're co-located. Every time an agent reads a file, they get the context automatically.

```typescript
/**
 * @fileoverview Markdown Table Config Factory Functions
 *
 * Provides convenience factory functions for creating `TableMarkdownConfig` objects.
 * The true default config (`DEFAULT_TABLE_CONFIG`) is defined in `markdown-index.ts`.
 */

// ...
```

When Claude reads `configs.ts`, it immediately knows what the file does and where related things live. No searching for a README. No inferring from code structure. The context is baked in.
