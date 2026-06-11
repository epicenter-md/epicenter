# Yjs Uses JavaScript, Not TypeScript (And It's Fully Typed Anyway)

Yjs is written entirely in JavaScript with JSDoc annotations, gets full type safety from `tsc`, and ships `.d.ts` files for consumers. No TypeScript source files exist in the repo.

> Types are great. TypeScript-the-language is optional. The TypeScript compiler understands JSDoc just fine.

Every `.ts` file in a project introduces a build step between you and the code that actually runs. Kevin Jahns decided that tradeoff wasn't worth it for Yjs, and he's not alone.

## The Yjs Approach

Yjs v14 source is 100% JavaScript. Every file in `src/` ends in `.js`. But run `tsc` against the codebase and you get full type checking, because TypeScript's compiler reads JSDoc annotations natively.

The `package.json` tells the story:

```
"types": "./dist/src/index.d.ts"
```

Consumers in TypeScript projects get complete type information. They'd never know the source isn't `.ts` files.

## Jahns's Reasoning

Jahns has [explained this on the Yjs forum](https://discuss.yjs.dev/t/why-are-yjs-types-writen-with-jsdocs-and-not-typescript/2668). His reasons are concrete:

| Concern | His position |
| --- | --- |
| Debugging | Transpilation breaks the Node debugger. Breakpoints jump around, source maps are unreliable. Plain JS means what you write is what runs. |
| Type safety | JSDoc gives identical type checking to `.ts` files when you run `tsc`. No coverage gap. |
| Language scope | TypeScript does more than types: polyfills, enum compilation, decorator transforms. He doesn't want any of that. |
| Future direction | The [TC39 Type Annotations proposal](https://github.com/tc39/proposal-type-annotations) would add type syntax directly to JavaScript. He'd rather wait for the standard. |

The debugging point is the sharp one. Anyone who's tried to step through transpiled async code in a Node debugger knows the pain. The debugger jumps to locations that don't correspond to your source, breakpoints land on the wrong line, and you're fighting the tool instead of finding the bug.

## Svelte Does the Same Thing

Svelte's team [made the same move in 2023](https://devclass.com/2023/05/11/typescript-is-not-worth-it-for-developing-libraries-says-svelte-author-as-team-switches-to-javascript-and-jsdoc/), switching their compiler internals from TypeScript to JavaScript with JSDoc. Rich Harris put it bluntly: "types are fantastic, TypeScript is a bit of a pain." SvelteKit had already been using this approach, and it "worked out fantastically."

Harris drew an important line: TypeScript for apps (which already have a build step), JSDoc for libraries (where eliminating the build step actually matters). Svelte consumers still write TypeScript. The library just doesn't.

Interestingly, the Svelte team is now [reconsidering moving back to TypeScript](https://github.com/sveltejs/svelte/issues/16647) for compiler internals, since Node 23.6+ can run `.ts` files natively. The calculus changes when the build step disappears from the runtime side too.

## The Pattern

This is a real pattern in the ecosystem, not just two projects being contrarian. The approach:

```
Source:     JavaScript with JSDoc annotations
Checking:   tsc (TypeScript compiler)
Output:     .d.ts declaration files for consumers
Debugging:  Direct, no source maps needed
```

The TypeScript compiler is the type checker. TypeScript-the-language is the part they skip.

For Yjs specifically, this means you get full IntelliSense, type errors in your editor, and autocomplete on `Y.Doc`, `Y.Map`, `Y.Array`: all generated from JSDoc comments in plain JavaScript files.

## References

- [Why are Yjs types written with JSDoc and not TypeScript?](https://discuss.yjs.dev/t/why-are-yjs-types-writen-with-jsdocs-and-not-typescript/2668) (Yjs Community)
- [TypeScript enhancement · Issue #490](https://github.com/yjs/yjs/issues/490) (yjs/yjs)
- [Svelte switches to JavaScript and JSDoc](https://devclass.com/2023/05/11/typescript-is-not-worth-it-for-developing-libraries-says-svelte-author-as-team-switches-to-javascript-and-jsdoc/) (DEVCLASS)
- [Reconsidering TypeScript for Svelte Compiler Internals · Issue #16647](https://github.com/sveltejs/svelte/issues/16647) (sveltejs/svelte)
- [Rich Harris on TypeScript vs JSDoc](https://x.com/Rich_Harris/status/1661051005985865728) (X)
