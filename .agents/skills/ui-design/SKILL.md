---
name: ui-design
description: 'UI design and component-system collapse hub for Epicenter interfaces. Use when designing, implementing, polishing, redesigning, or reviewing visible UI; choosing @epicenter/ui components; changing packages/ui; building Svelte state surfaces; or replacing class-heavy markup, arbitrary Tailwind values, custom colors, and local interface primitives. Every meaningful UI change preserves the user-visible objective while challenging inherited structure and collapsing toward shared primitives. Not for a tiny CSS-only repair unless it reveals a broader pattern.'
metadata:
  author: epicenter
  version: '1.0'
license: Complete terms in LICENSE.txt
---

# UI Design

`ui-design` preserves the user-visible objective while reimagining the simplest
greenfield composition and collapsing local markup, arbitrary styling, and
duplicated visual contracts into `@epicenter/ui`, except where app-specific
behavior or a load-bearing interaction earns the custom shape.

The existing screen is evidence, not a structure to reproduce. For Epicenter
product apps, `@epicenter/ui` is the default system. Treat shadcn-svelte as
implementation lineage and upstream grounding, not as an app import path.

## Canonical Path

1. Name the user-visible objective in one concrete sentence.
2. Read the current and neighboring surfaces. Inventory the workflow, hierarchy,
   accessibility, important states, and recognizable product intent that matter.
3. Sketch the simplest greenfield composition using the natural anatomy of
   existing `@epicenter/ui` primitives.
4. Run the component-system collapse pass below. Refuse exact reproduction of
   incidental markup, spacing, colors, breakpoints, and one-off states.
5. Implement the whole state surface: loading, empty, error, disabled, pending,
   selected, and filter-empty where relevant.
6. Verify visible, responsive, and interactive results in the browser.
7. Run UI pre-flight before final handoff or committing the change.

For substantial work, state the design read:

```txt
Objective: <what the user accomplishes>.
Greenfield shape: <the simplest natural component-system composition>.
Collapse: <the local structure or styling that disappears>.
```

## Component-System Collapse Pass

Run this for every meaningful UI implementation or review, not only work called
a redesign. This is the UI application of
[asymmetric-wins](../asymmetric-wins/SKILL.md); load that skill when a candidate
refusal needs an explicit product-loss versus deletion-prize decision.

```txt
Preserve the product sentence.
Challenge the inherited composition.
Refuse the incidental visual promise.
Delete the local code family.
```

Inspect every wrapper, class bundle, arbitrary Tailwind value, custom color,
locally reconstructed state surface, and primitive override. Ask:

1. Does an existing primitive or variant already own this contract?
2. Can the primitive's natural shape replace the wrapper and its classes?
3. Is the exact local detail load-bearing for comprehension, accessibility,
   interaction, brand, or required geometry?
4. If it survives, who owns it: the app's product behavior or the shared system?

Implement obvious collapses directly. Ask the user only when the refusal changes
workflow, hierarchy, product meaning, brand posture, or a plausibly load-bearing
detail.

Keep custom UI app-local only when it owns app-specific behavior or product
meaning. Move a stable visual contract into `packages/ui` when several apps need
it or it owns an accessibility or interaction contract.

## Human Taste Gate

Ask one focused question when human preference would materially change the
visual language, brand posture, primary hierarchy, navigation, density, or the
direction of an expressive public surface. Present concrete alternatives and a
recommendation. Do not ask about choices settled by the shared system,
accessibility, existing product intent, or a mechanical collapse.

## Product UI And Expressive Surfaces

Product UI should usually be dense, quiet, and operational. Distinctiveness
comes from workflow fit, hierarchy, copy, state design, and purposeful details.
Marketing pages, docs entry points, prototypes, and explicitly expressive work
can use a stronger visual identity, but still run the collapse pass and keep only
details that serve the chosen direction.

## References

- Read [references/component-system.md](references/component-system.md) for every
  meaningful Epicenter product UI implementation or review. It owns collapse
  smells and exceptions, then routes exact component and package mechanics to
  the authoritative `packages/ui` guide.
- Read [references/anti-slop-tells.md](references/anti-slop-tells.md) for public,
  marketing, docs, portfolio-like, or highly polished work where templated output
  is a material risk.
- Read [references/preflight.md](references/preflight.md) before final handoff or
  committing any visible UI change. Report only failures or intentional exceptions.

## Delegation Boundaries

- `styling` owns CSS, Tailwind, spacing, wrappers, overflow, and scroll traps.
- `svelte` owns component structure, runes, lifecycle, and state mechanics.
- `tanstack-table` owns table state, columns, sorting, and row identity.
- `co-design` owns interactive exploration before a product direction is chosen.
- `web-design-guidelines` owns an explicit external standards or accessibility audit.
- `writing-voice` owns visible interface copy and tone.

The design decision and component-system collapse stay here even when another
skill owns their implementation mechanics.

## Final Output

Report the changed surfaces, browser verification, any material deletion prize,
and only the custom shapes or pre-flight exceptions that intentionally remain.
