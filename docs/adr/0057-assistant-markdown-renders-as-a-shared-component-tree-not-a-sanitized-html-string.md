# 0057. Assistant markdown renders as a shared component tree, not a sanitized HTML string

- **Status:** Accepted
- **Date:** 2026-06-23

## Context

Each chat app (vocab, tab-manager, opensidian) rendered a settled assistant
message by parsing markdown to an HTML string, sanitizing it with DOMPurify, and
injecting it with `{@html}`. vocab additionally annotated that string with pinyin
by splitting the HTML with a regex and wrapping CJK runs in `<ruby>` tags. A
parser feeding a regex feeding a sanitizer feeding `{@html}`, duplicated three
ways, with romanization welded into the HTML string: the regex-over-HTML pass was
the load-bearing smell.

## Decision

Render a settled assistant message by lexing it with `marked.lexer` and walking
the tokens into a real Svelte DOM tree, shipped once as `@epicenter/ui/markdown`
and consumed by all three chat apps. Text leaves run an injected `Romanizer` that
returns `Segment[]`, and each reading segment becomes a native `<ruby>`. Because
the output is real nodes and never an untrusted string, `{@html}` and DOMPurify
are deleted; the only attribute surface (link `href`, image `src`) is
scheme-checked in place of DOMPurify's URL filter.

The romanizer contract (`Romanizer`, `Segment`) lives with the renderer that
consumes it, in `@epicenter/ui/markdown`, not vocab-local: apps depend on
`@epicenter/ui` and not the reverse, so a vocab-local type would force a
duplicated, duck-typed copy across the package boundary. vocab's
`pinyinRomanizer` imports the contract from the renderer.

Romanization is a one-shot pass on settle. Streaming messages render raw text;
the rich markdown plus romanization runs exactly once when a message persists.
Whether readings show is a presentation toggle (`showReadings`), not a romanizer
mode: with readings off the renderer uses an identity romanizer, the same path an
app that injects no romanizer takes.

## Consequences

- One renderer, three consumers: vocab injects pinyin, tab-manager and opensidian
  pass none, and opensidian gains markdown it previously lacked.
- `marked` and `dompurify` drop out of the apps; `marked` moves to `@epicenter/ui`.
- Safety shifts from "sanitize a string" to "never build one." Injected markup is
  structurally impossible; a real `javascript:`, `data:`, or `vbscript:` link is
  the remaining path, blocked by the scheme check.
- Raw inline HTML an assistant emits renders as visible text, not live markup.
- Token coverage is now ours: a marked token type with no branch falls back to its
  raw source rather than throwing. The CJK-adjacency invariant (你好 must not split
  to 你 好) rides on whitespace-tight inline templates, which a careless reformat
  could break.
- Supersedes the "keep `{@html}` + DOMPurify for now" and "romanizer types stay
  vocab-local" decisions from spec `20260622T205500`, now deleted; its body
  remains recoverable from git history.
