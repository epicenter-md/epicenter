---
name: co-design
description: Run an interactive product design pass before implementing UI. Use when the user asks to co-design, explore UI direction, improve a screen, design a feature surface, compare options, create design directions, or turn a rough product idea into a buildable Svelte interface.
metadata:
  author: epicenter
  version: '1.0'
---

# Co-Design

Co-design turns a rough UI request into a buildable direction. It is not a visual polish pass. It is the step that decides what the surface is for, what category pattern it should borrow from, and what implementation proof is needed before the design is called done.

## Related Skills

Use these skills as the work narrows:

- [comparable-apps](../comparable-apps/SKILL.md): before choosing the UX pattern.
- [ui-design](../ui-design/SKILL.md): when committing to visual direction,
  choosing local components, and implementing state surfaces.
- [prototype](../prototype/SKILL.md): when the answer needs multiple UI variants or a throwaway route.
- [web-design-guidelines](../web-design-guidelines/SKILL.md): for final accessibility and interface review.

## Workflow

Start with the smallest useful design brief:

```txt
Surface:
  What screen, component, or flow is changing?

User job:
  What is the user trying to get done?

Category:
  Which comparable product category should this feel like?

Constraint:
  What must stay true in this repo, app, or design system?
```

If the request is vague but implementation can still move, state the assumption and continue. Ask a question only when the answer would change the surface or data model.

## Design Pass

Before coding a meaningful UI surface:

1. Write a one-sentence thesis for the screen.
2. Name 3 to 5 comparable apps or local surfaces and the pattern being borrowed or refused.
3. Choose one primary direction. For uncertain UI work, create 2 or 3 prototype directions before choosing.
4. Translate the direction into concrete controls, states, density, layout, and copy.
5. Implement with existing Svelte, Tailwind, and `@epicenter/ui` patterns.
6. Verify in the browser when the result is visual, responsive, or interactive.

## Output Shape

For design discussion, keep the answer compact:

```txt
Thesis:
  One sentence.

Comparisons:
  App or surface | Pattern | Borrow or refuse

Direction:
  The chosen design and why it fits Epicenter.

Implementation:
  Files or surfaces that need to change.
```

For implementation, do the work directly. After editing, report the files changed, the visual verification performed, and any remaining design risk.

## Rules

- Keep Epicenter workspace-first. Identity, sync, and account surfaces should stay recessive unless the product job says otherwise.
- Prefer dense, quiet, operational UI for tools. Avoid landing-page composition inside workspace surfaces.
- Use local `@epicenter/ui` components before one-off state markup.
- Do not create a prototype when the existing app surface is enough to answer the question.
- Do not stop at mood words. Every design direction must map to layout, controls, states, and verification.
- Do not call the design done without seeing it when visual regressions are plausible.
