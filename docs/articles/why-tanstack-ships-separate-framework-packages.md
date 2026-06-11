# One Package Can't Honestly Declare Peer Deps for Every Framework

TanStack ships a separate npm package per framework because no single package can tell an honest peer-dep story for React, Svelte, Vue, and Solid all at once. One package means one peer-dep declaration, and with four frameworks, that declaration always lies to somebody.

## The fetching logic is portable; the reactivity glue is not

`@tanstack/query-core` has no peer dependencies. Zero. It manages caches, handles background refetches, tracks query states, coordinates deduplication. None of that needs React or Svelte. It's plain TypeScript.

The framework binding is a thin layer on top that translates query state into something the framework's reactivity model understands. React gets hooks. Svelte gets stores (now runes). Vue gets refs. Solid gets signals. These aren't stylistic choices: each one is a fundamentally different mechanism for notifying the UI that data changed, and they don't translate into each other. You can't write one adapter that works for all of them. You write four adapters.

The core is portable. The glue is not.

## A single package's peer deps have to cover everyone

Imagine TanStack had shipped one package: `@tanstack/query`. To support all four frameworks, the `package.json` would have to declare all four as peer dependencies:

```json
{
  "name": "@tanstack/query",
  "peerDependencies": {
    "react": "^18 || ^19",
    "svelte": "^5.25.0",
    "vue": "^2.6.0 || ^3.3.0",
    "solid-js": "^1.0.0"
  }
}
```

Install this in a React app. npm sees four peer dependencies. React is installed; the other three are not. You get three warnings every time you install or add a dependency:

```
npm warn peer dep missing: svelte@^5.25.0
npm warn peer dep missing: vue@^2.6.0 || ^3.3.0
npm warn peer dep missing: solid-js@^1.0.0
```

You can mark them optional with `peerDependenciesMeta`:

```json
{
  "peerDependenciesMeta": {
    "react":    { "optional": true },
    "svelte":   { "optional": true },
    "vue":      { "optional": true },
    "solid-js": { "optional": true }
  }
}
```

That silences the warnings. It also silences the warning when you're in a React app and forget to install React entirely. Now the tooling can't tell the difference between "you're using the Vue binding, you don't need React" and "you forgot to install your framework." Every peer dep became a shrug.

## The split gives every consumer an honest dependency story

Here's what the actual packages look like:

```json
// @tanstack/react-query: v5.99.2
{
  "peerDependencies": {
    "react": "^18 || ^19"
  }
}
```

```json
// @tanstack/svelte-query: v6.1.18
{
  "peerDependencies": {
    "svelte": "^5.25.0"
  }
}
```

```json
// @tanstack/vue-query: v5.99.2
{
  "peerDependencies": {
    "vue": "^2.6.0 || ^3.3.0"
  }
}
```

A React app installs `@tanstack/react-query`. One peer dep. If React is missing, the warning is meaningful. You actually need it. If React is present, there are no warnings. The feedback is honest because the package only knows about one framework.

Version numbers can also drift independently. Svelte 5 was a major rewrite; `@tanstack/svelte-query` bumped to v6 to track it. The React and Vue packages stayed at v5. A single package can't version-track four frameworks without forcing everyone to upgrade together.

## What TanStack pays for this

More packages to publish and maintain. Every change to `query-core` requires a coordinated release across all four binding packages. They all declare `@tanstack/query-core` as a direct dependency and need to be updated in lockstep. That's convention, not enforcement; a careless release could let them drift.

The maintenance overhead is real. It's the cost of serving four different ecosystems with honest packaging.

## When you don't need this

If you support one framework, you don't have this problem. One package, one peer dep, subpath exports if you want to keep framework-agnostic utilities separate:

```json
{
  "name": "my-library",
  "exports": {
    ".": "./dist/index.js",
    "./react": "./dist/react.js"
  },
  "peerDependencies": {
    "react": "^18 || ^19"
  }
}
```

One peer dep, no lies. The N×M problem only bites when N (frameworks you support) is 2 or more. Before that, the split creates overhead with no benefit.

If you do eventually need to add a second framework, going from "one package with subpath exports" to "separate packages" is mechanical. Rename a directory, bump an import path, republish. No API break for existing consumers. Starting with subpath and splitting later costs one refactor when the second framework lands, not an early bet on complexity you might not need.
