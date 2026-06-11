# Markdown Normalization Converges in One Pass

**TL;DR**: Parse-serialize cycles normalize markdown syntax (`*italic*` → `_italic_`), but the output stabilizes after one pass. No ping-pong, no loops.

> When you round-trip markdown through a parser and serializer, you get one normalization pass, then it stops. This is why ProseMirror-backed Y.Text doesn't create infinite update loops.

## The Problem

I was building ProseMirror on top of Y.Text and hit a scary thought: every keystroke serializes the doc to markdown. If that serialization changes the markdown on every pass, I'd get an infinite loop:

```
User types → PM serializes → diff → Y.Text update →
observer fires → parse → new PM doc → serialize → diff → ...
```

People worry that `*italic*` and `_italic_` will ping-pong between peers. They don't.

## The Proof

Watch what happens when you serialize the same content twice:

```typescript
serialize(parse("*italic*"))                       // → "_italic_"
serialize(parse("_italic_"))                       // → "_italic_"
serialize(parse(serialize(parse("*italic*"))))     // → "_italic_"
```

After the first roundtrip, the output is stable. `serialize(parse(x))` is a fixed point of `serialize(parse())`. Run it again, you get the same string. No changes. No diff. No loop.

Here's the full picture:

```
Pass 1:  "*italic* with __bold__"
         ↓ parse → serialize
         "_italic_ with **bold**"

Pass 2:  "_italic_ with **bold__"
         ↓ parse → serialize
         "_italic_ with **bold__"  ← same output

Pass 3:  "_italic_ with **bold__"
         ↓ parse → serialize
         "_italic_ with **bold__"  ← still the same
```

The normalization happens once. Then it stops.

## Why This Matters

The outbound path (ProseMirror → Y.Text) serializes on every keystroke. If serialization produced different output each time, you'd create ops on every keystroke even when the content didn't change. The diff would never be empty.

But because the output stabilizes, the second serialize produces the exact same string as the first. The diff is empty. No ops. No observer fires. No loop.

## What You Actually See

The one-time normalization is visible in git and source view:

```markdown
// Original file
*italic* with __bold__ and + list items

// After first edit (any edit triggers parse-serialize)
_italic_ with **bold** and - list items
```

The content is identical. Only the syntax markers changed. In the rich text editor, the user sees zero difference. In source view, they see a one-time normalization commit.

After that first edit, the file is stable. Future edits only change actual content.

## Make It Deterministic

Pin your remark-stringify options:

```typescript
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';

const processor = unified()
  .use(remarkParse)
  .use(remarkStringify, {
    emphasis: '_',
    strong: '**',
    bullet: '-',
    rule: '---',
  });
```

Now the normalization is predictable. Everyone knows `*italic*` becomes `_italic_`. No surprises.

## The Gotcha: Multiple Serializers

The normalization happens once per serializer. If every writer uses the same remark-stringify config, normalization happens exactly once ever. But if different tools use different serializers, you get re-normalization each time a different writer touches the file:

| Writer       | Serializer Config    | What Happens                     |
|--------------|----------------------|----------------------------------|
| ProseMirror  | `emphasis: '_'`      | Normalizes to `_italic_`         |
| CLI tool     | `emphasis: '*'`      | Re-normalizes to `*italic*`      |
| Agent script | `emphasis: '_'`      | Re-normalizes back to `_italic_` |

The solution: standardize on one serializer. Pin the config in a shared package. Every writer imports the same processor. You get one normalization pass across the entire system.

## The Golden Rule

Normalization is idempotent: `serialize(parse(serialize(parse(x)))) === serialize(parse(x))`. After one pass, the output is stable. No loops, no chaos, just predictable syntax.

## Related

- [Parser Fidelity Is Your Single Point of Failure](./parser-fidelity-is-your-single-point-of-failure.md): When the parse step destroys content, not just syntax
- [Diff-Based Sync Guesses Intent, CRDT Operations Express It](./diff-reconciliation-is-not-a-crdt-operation.md): The sync function that relies on this stability
- [Y.Text vs Y.XmlFragment: Pick Your Tradeoff](./ytext-vs-yxmlfragment-pick-your-tradeoff.md): The full comparison
