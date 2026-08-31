---
name: svg-animations
description: Animate SVGs with SMIL, CSS keyframes, stroke drawing, shape morphing, and motion paths. Use when adding motion to SVGs such as spinners, logos, draw-in effects, or morphing icons, not for static drawing or icon layout.
---

Handcrafted SVG animation. Every SVG element is a DOM node you can style, animate, and script; the craft is picking the right animation layer and dodging the handful of gotchas below.

Read [references/recipes.md](references/recipes.md) when you need a ready-made pattern: loading spinner, animated checkmark, hamburger-to-X morph, motion along a path, gradient color shift, pulsing glow, or wave.

## Choose the Animation Layer

SMIL (`<animate>`, `<animateTransform>`, `<animateMotion>`, `<set>`) lives inside the SVG markup and keeps working when the file is loaded via `<img>` or CSS `background-image`, where CSS and JS cannot reach. Prefer SMIL for self-contained assets (icons, logos); use CSS keyframes when the SVG is inlined and the animation should coordinate with the rest of the page.

## Gotchas That Bite

- `transform-origin: center`: SVG transforms default to the viewBox origin (0,0), not the element center. Set it explicitly in CSS, or pass explicit center coordinates in SMIL (`from="0 25 25" to="360 25 25"`).
- `fill="freeze"` on SMIL animations keeps the final state; without it the element snaps back to the start.
- Shape morphing (SMIL `values` on `d`, or the CSS `d` property) interpolates only between paths with the same number and types of commands in the same order. If shapes differ, add invisible intermediate points to equalize.
- Use `path.getTotalLength()` for exact lengths in stroke-drawing animations instead of guessing dash values.
- Size with `viewBox` only; hardcoded `width`/`height` breaks resolution independence. Put gradients, filters, masks, and reusable shapes in `<defs>`.
- `stroke-linecap="round"` makes line animations look polished.

## The Stroke Drawing Trick

Set `stroke-dasharray` and `stroke-dashoffset` to the path length, then animate the offset to 0 so the path draws itself:

```svg
<path class="draw" d="M 20 100 C 20 50, 80 50, 80 100 S 140 150, 140 100"
      fill="none" stroke="#1a1a1a" stroke-width="3" />
<style>
  .draw {
    stroke-dasharray: 300;
    stroke-dashoffset: 300;
    animation: draw 2s ease forwards;
  }
  @keyframes draw {
    to { stroke-dashoffset: 0; }
  }
</style>
```

Stagger multiple paths with `animation-delay`.

## SMIL Timing and Easing

Chain animations by id instead of hand-summing delays:

```svg
<animate id="first" attributeName="cx" to="150" dur="1s" fill="freeze" />
<animate attributeName="cy" to="150" dur="1s" begin="first.end" fill="freeze" />
```

`begin` also accepts `click`, `2s`, `other.end + 1s`, and `other.repeat(2)`. For easing, use `calcMode="spline"` with `keySplines` cubic-bezier control points per interval (ease-in-out is `0.42 0 0.58 1`); the default is linear.

## Performance and Accessibility

Animating `transform` and `opacity` is GPU-composited; animating `d`, `points`, or layout attributes triggers repaints, so use those sparingly on complex SVGs. `will-change: transform` helps the browser optimize compositing.

Add `role="img"` and `<title>`/`<desc>`, and honor reduced motion:

```css
@media (prefers-reduced-motion: reduce) {
  svg * {
    animation: none !important;
    transition: none !important;
  }
}
```
