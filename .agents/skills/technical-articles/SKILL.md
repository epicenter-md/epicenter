---
name: technical-articles
description: Writing technical articles and blog posts. Use when creating articles in docs/articles/ or blog content explaining patterns, techniques, or lessons learned.
metadata:
  author: epicenter
  version: '1.0'
---

# Technical Articles

All articles must follow [writing-voice](../writing-voice/SKILL.md) rules.

## When to Apply This Skill

Use this pattern when you need to:

- Write technical articles in `docs/articles/` or blog-style engineering posts.
- Turn headings and titles into arguments instead of neutral topic labels.
- Structure prose, code, and visuals with deliberate rhythm and pacing.
- Open with the core insight first instead of announcing the topic.
- Edit drafts to remove AI tell patterns and keep writing concrete.

## Core Principles

Title should BE the takeaway, not a topic. "Write Context to a File, Not a Prompt" not "Context Management in Agent Workflows".

Lead with a strong opening paragraph that states the key insight in plain language. Reader should get it in 5 seconds. Then go straight into code. Don't force a blockquote or pull-quote after the opening; if the insight needs a quotable summary, the opening paragraph already is one.

Code speaks louder than prose. Show real examples from actual codebases, not abstract `foo`/`bar` illustrations. If the code is self-explanatory, don't over-explain.

## Section Headings Are Arguments

Section headings should make claims, not announce topics. The reader should know your position from the heading alone.

Bad (topic headings):

> ## What's in the binary
>
> ## How Go and Rust compare
>
> ## Why tree-shaking is difficult

Good (argument headings):

> ## Go and Rust: Your code IS the binary
>
> ## Bun (and Deno/Node): Your code rides on top of a VM
>
> ## Why tree-shaking the runtime is brutally hard

The first set describes what the section is about. The second set tells you what the section argues. A reader who only skims headings should walk away with the article's core argument.

This applies to the title too: "Bun Compile Is 57MB Because It's Not Your Code" is an argument. "Understanding Bun Compile Binary Size" is a topic.

## Conversational Directness

Write like you're explaining to a peer, not presenting to an audience. Short declarative sentences. Opinions stated plainly. Concessions acknowledged without hedging.

Bad (formal article-speak):

> The resulting bundle size of the `bun build --compile` command is notably large. With careful analysis, we can identify several contributing factors.

Good (direct, conversational):

> A `console.log("Hello World")` compiles to 57MB. Your code adds almost nothing. The binary is the entire Bun runtime.

Parenthetical asides, dashes for emphasis, and sentence fragments are all fine when they serve clarity. "Stripping the JIT? Now your code runs 10-100x slower." reads better than a formally constructed alternative.

## Visual Elements Are Tools, Not Checkboxes

ASCII diagrams, tables, and before/after code blocks are tools to reach for when they clarify something prose can't. They are not required ingredients.

Use a diagram when showing flow or architecture that's hard to describe linearly. Use a table when there's a genuine comparison with 3+ items. Use before/after code when the contrast IS the point. Skip all of them when the article doesn't need them.

When you have multiple independent reasons for something, write them as regular prose with natural transitions. Don't use numbered bold headings (`**1. Bold heading**` followed by explanation)—that pattern is one of the most recognizable AI writing tells.

## Rhythm and Pacing

This is the most important section. Good articles alternate between prose and visuals. The reader's eye should bounce: context → code → explanation → diagram → implication. Neither prose nor code should dominate for long stretches.

### The Rules

1. **Max 3-4 sentences of prose before a code block, diagram, or table.** If you're writing more than that without a visual break, you're missing an opportunity.
2. **Every code block gets 1-2 sentences of setup before it.** Don't drop code without context. But don't write a paragraph either.
3. **After a code block, one sentence of explanation is often enough.** If the code is self-explanatory, skip it entirely and bridge to the next idea.
4. **Use line breaks between distinct thoughts.** Don't pack three ideas into one paragraph. Each paragraph: one idea.

### Good rhythm — prose and code alternate:

```
[1-2 sentences: what the problem is]

\`\`\`typescript
// code showing the problem
const result = table.find(id);  // O(n) scan every time
\`\`\`

[1 sentence: why this is bad, bridge to solution]

\`\`\`typescript
// code showing the solution
const result = index.get(id);   // O(1) lookup
\`\`\`

[1-2 sentences: what this means for the reader]
```

### Bad rhythm — wall of prose, code at the end:

```
[Paragraph explaining the problem]
[Paragraph explaining the approach]
[Paragraph explaining the implementation]
[Paragraph explaining the result]

\`\`\`typescript
// single code block at the bottom
\`\`\`
```

The first version lets the reader verify each claim against code as they go. The second forces them to hold four paragraphs in memory, then mentally map them to code.

## Writing the Opening

The opening paragraph carries the entire article. If someone reads nothing else, this paragraph should give them the insight.

Bad (topic announcement):

> In this article, we'll explore how context management works in agent workflows and discuss some approaches to improving it.

Good (insight up front):

> Write your context to a file, not a prompt. When a conversation spawns sub-agents, each one starts with a blank slate. If the context lives in a spec file on disk, every agent can read it fresh instead of relying on copy-pasted prompt fragments that drift.

The bad version tells the reader what the article is about. The good version tells them the answer. They'll keep reading to see why.

## Writing Explanatory Prose

When you need to explain how something works between code blocks, show the mechanism. Don't describe it abstractly.

Bad (abstract narration):

> The system uses a layered approach to handle data storage efficiently. Each layer provides a different level of abstraction, allowing consumers to interact with data at the appropriate granularity for their use case.

Good (shows the mechanism):

> `RowStore` wraps `CellStore`, which wraps `YKeyValueLww`. Each layer adds one thing: `YKeyValueLww` handles conflict resolution, `CellStore` parses cell keys into row/column pairs, and `RowStore` maintains an in-memory index for O(1) lookups. The consumer only sees `RowStore`.

The first version could describe anything. The second version could only describe this system.

## Constraints

Bullet lists and numbered lists: max 1-2 of each per article. If you need more, convert to prose or a table.

Section headings: use sparingly. Not every paragraph needs a heading. Let content flow naturally between ideas using bridge sentences (see [writing-voice](../writing-voice/SKILL.md) "Connect ideas without headers").

Bold text: avoid in body content. Use sparingly if needed for emphasis.

No space-dash-space: use colons, semicolons, or em dashes per writing-voice.

No rigid template: structure should fit the content, not the other way around. Some articles need a "Problem/Solution" flow; others just show code and explain. Don't force sections.

## Articles Have Different Shapes

Don't follow a single template. Structure should fit the content. Some common shapes:

**Problem → fix** (short, practical): State the problem, show the code that fixes it, explain why. No diagrams, no tables, no extra sections. 30-50 lines.

**Mechanism explainer** (medium): Explain how something works under the hood, alternating prose and code. Diagrams when the flow is non-obvious. 50-80 lines.

**Comparison or tradeoff analysis** (longer): Show two or more approaches with real code from each. A table can help here because the comparison IS the point. ASCII diagrams when architecture differs between approaches. 80-150 lines.

The shape emerges from the content. If you find yourself adding a diagram or table to fill a perceived gap, you don't need it.

## What Makes Articles Good

- Real code from real codebases, not abstract examples
- Tight prose that explains WHY, not WHAT (code shows WHAT)
- Prose and visuals alternate naturally; neither dominates for long stretches
- Opening paragraph delivers the insight, not a topic announcement
- Visual elements (diagrams, tables) only when they earn their place
- Length matches content: 30-50 lines for focused fixes, 80-150 for comparisons

## What Makes Articles Bad

- Rigid section structure that doesn't fit the content
- Multiple bullet lists and numbered lists throughout
- Abstract `foo`/`bar` code examples
- Over-explaining self-explanatory code
- Bold formatting scattered through body text
- Numbered bold headings for multi-part arguments (`**1. Bold heading**` pattern)
- Summary tables tacked on at the end that restate what the prose already said
- Marketing language or AI giveaways
- More than 4-5 sentences of prose without a visual break
- Opening that announces the topic instead of delivering the insight
- Closing that reaches for a grand summary or call to action

## Narrative Mode (Rare)

Most "journey to an insight" articles still work better as punchy. Use narrative only when the discovery process itself is the insight and can't be compressed.

When narrative fits: specific details ("750 lines", not "a large file"), direct statements over manufactured drama, build to an insight rather than starting with it.

## Closings

End with a plain statement of the implication. Don't reach for a grand summary or a clever sign-off. If the article showed that X solves Y, just say what that means for the reader in one or two sentences. Avoid closing with superlatives ("the most elegant", "truly powerful") or calls to action ("try it today!").
