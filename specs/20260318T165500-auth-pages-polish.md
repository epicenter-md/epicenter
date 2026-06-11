# Auth Pages Polish

Follow-up to `20260318T101545-auth-pages-fixes.md`. Two remaining issues from the device flow UX review.

## Problem

1. **Sign-in page styling is bare-bones.** Card uses a visible border instead of shadow, colors are hardcoded hex values that don't match the design system, no Epicenter branding. Looks like a developer prototype, not a shipped product.

2. **No signed-in state.** When an already-authenticated user visits `/sign-in` without OAuth or callbackURL params, they see the sign-in form again. No confirmation that they're authenticated, no way to sign out from this page.

## Files

- `apps/api/src/auth-pages/styles.ts`: Shared inline CSS for all auth pages
- `apps/api/src/auth-pages/layout.tsx`: HTML shell wrapping all auth pages
- `apps/api/src/auth-pages/signed-in-page.tsx`: NEW: signed-in confirmation component
- `apps/api/src/auth-pages/index.tsx`: Render function exports
- `apps/api/src/app.ts`: Route handler for `/sign-in`

## Fix 1: Styling polish

- [x] Replace card `border: 1px solid #e5e5e5` with `box-shadow` (subtle elevation)
- [x] Switch hardcoded hex colors to oklch values matching `packages/ui/src/app.css` design tokens
- [x] Bump h1 from 1.25rem to 1.5rem for better visual hierarchy
- [x] Improve button padding (.625rem → .75rem) for better click targets
- [x] Better focus ring: 2px ring with brand primary + subtle opacity (not just border-color)
- [x] Add Epicenter logo mark (two overlapping circles from favicon.svg) to layout.tsx, rendered above every card

## Fix 2: Signed-in confirmation page

- [x] Create `signed-in-page.tsx` with green checkmark, "You're signed in", display name, email, and Sign Out button
- [x] Add `renderSignedInPage` to `index.tsx`
- [x] In `/sign-in` route: when session exists + no `sig` or `callbackURL` → render signed-in page with user info
- [x] Sign Out button POSTs to `/auth/sign-out` then reloads (shows sign-in form)

## Commit plan

1. `style(api): polish auth page CSS and add Epicenter logo`: styles.ts + layout.tsx
2. `feat(api): show signed-in confirmation when already authenticated`: signed-in-page.tsx + index.tsx + app.ts

---

## Review

Both fixes implemented in 2 commits.

| Commit | Fix | Files changed |
|--------|-----|---------------|
| Wave 1 | CSS polish + Epicenter logo | styles.ts, layout.tsx |
| Wave 2 | Signed-in confirmation page | signed-in-page.tsx, index.tsx, app.ts |

**Design system alignment**: Colors now use oklch values from `packages/ui/src/app.css` (--foreground, --muted-foreground, --border, --primary, --destructive, --success). Card uses box-shadow instead of border. Focus ring uses brand primary with opacity.

**Logo**: Epicenter mark (two overlapping circles) rendered as inline SVG in the layout, appearing above every auth card. Matches `apps/landing/public/favicon.svg`.

**Signed-in page flow**: Already-authenticated user → sees green check + name/email + Sign Out button. Sign Out → POST `/auth/sign-out` → reload → sees sign-in form. No redirect loops.

**Open redirect prevention**: Unchanged: `callbackURL` still only honored when it starts with `/`.
