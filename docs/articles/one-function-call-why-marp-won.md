# One Function Call: Why Marp Won

When we started building the slideshow feature for Epicenter, our requirement was simple: take a string of markdown from an LLM and programmatically spit out a presentation. We needed a rendering engine that could live inside a SvelteKit app, run in a serverless function, or even execute entirely in the browser.

I had been following Marp for years. It is the quiet, reliable workhorse of the markdown-to-slides world with 10.4K stars. The other obvious contender was Slidev. With 44K stars and a feature set that makes YouTubers drool. Shiki code highlighting, Vue-powered animations, and "Magic Move" transitions. Slidev is the darling of the modern web.

But when we looked at the code required to actually render a slide, the choice became clear. Marp's entire rendering pipeline is a single function call.

```typescript
import { Marp } from '@marp-team/marp-core';

const marp = new Marp({ script: false, math: false });
const { html, css } = marp.render(markdownString);
```

That is the entire integration. String in; HTML and CSS out. It is a pure in-memory transformation with no filesystem dependencies, no dev server, and no browser environment required. We built a proof of concept in a SvelteKit app that renders Marp slides inside a Shadow DOM in about 5ms: https://github.com/EpicenterHQ/epicenter/blob/81f2fe8bf/apps/marp-test/src/routes/+page.svelte

Slidev's architecture is fundamentally different. While it provides `@slidev/parser` to turn markdown into structured data, that only gets you halfway there.

```typescript
import { parseSync } from '@slidev/parser';

// This returns SourceSlideInfo[], not rendered HTML
const data = parseSync(markdownString, 'virtual.md');
```

To get from that data to a rendered slide, Slidev relies on a complex web of Vite plugins that transform markdown into Vue single-file components. There is no `new Slidev().render(string)` equivalent. To see a slide, you need a running Vite dev server or a full build process.

The pipeline comparison looks like this:

```
Marp:    markdown string -> marp.render() -> { html, css }
Slidev:  markdown string -> parser -> data -> Vite plugins -> Vue SFCs -> Vite dev server -> HTML
```

For a user authoring a presentation locally, Slidev's architecture is a feature; it provides a rich, reactive environment with hot module replacement. But for our use case. Where an LLM generates content and the user needs an instant preview. Slidev's requirement for a project directory and a dev server was a dealbreaker. Marp can run in a Lambda or a browser worker; Slidev needs a container.

We did have to accept some trade-offs. By choosing Marp, we gave up the high visual ceiling of Slidev. Marp's output is essentially a well-designed PDF. There are no entrance animations or complex transitions. This is a philosophical choice by the Marp team; their maintainer has explicitly stated that "a lot of animated things in the presentation will go against the common principles for creating better slides."

We traded "Magic Move" for a one-liner that works anywhere. If you are building a tool for speakers to hand-craft their own decks, Slidev is the superior choice. But if you are building a rendering engine for programmatic content, the simplicity of a single function call wins every time.
