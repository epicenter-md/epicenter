# Auth Pages Fixes

Server-rendered auth pages at `apps/api/src/auth-pages/` have session gate bugs, dead code, and inline script hygiene issues.

## Files

- `apps/api/src/app.ts`: Route definitions for `/sign-in`, `/consent`, `/device`
- `apps/api/src/auth-pages/sign-in-page.tsx`: Sign-in/sign-up page + ~130-line inline script
- `apps/api/src/auth-pages/consent-page.tsx`: OAuth consent page + ~60-line inline script
- `apps/api/src/auth-pages/device-page.tsx`: Device auth page + ~70-line inline script
- `apps/api/src/auth-pages/index.tsx`: Render function wrappers
- `apps/api/src/auth-pages/layout.tsx`: Shared HTML shell (no changes needed)
- `apps/api/src/auth-pages/styles.ts`: Shared CSS (no changes needed)

## Key API

Session check in Hono route handlers (established pattern at app.ts L346-358):

```typescript
const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
// Returns { user, session } | null
```

---

## Fix 1: Device + consent page auth gates (bug: highest priority)

**Problem:** `/device` and `/consent` GET routes render pages without session checks. When the user clicks Approve, the POST returns 401. The user sees "Sign in first, then come back to this page" but has no way to sign in.

**Fix: server side (app.ts):**

`/device` route: Before rendering, check session. If unauthenticated, redirect:
```typescript
app.get('/device', sValidator('query', type({ 'user_code?': 'string' })), async (c) => {
  const { user_code: userCode } = c.req.valid('query');
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    const callbackURL = userCode ? `/device?user_code=${encodeURIComponent(userCode)}` : '/device';
    return c.redirect(`/sign-in?callbackURL=${encodeURIComponent(callbackURL)}`);
  }
  return c.html(renderDevicePage({ userCode }));
});
```

`/consent` route: Same pattern: redirect to sign-in preserving the full query string:
```typescript
app.get('/consent', sValidator('query', type({ 'client_id?': 'string', 'scope?': 'string' })), async (c) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    const url = new URL(c.req.url);
    return c.redirect(`/sign-in?callbackURL=${encodeURIComponent('/consent' + url.search)}`);
  }
  const { client_id: clientId, scope } = c.req.valid('query');
  return c.html(renderConsentPage({ clientId, scope }));
});
```

**Fix: sign-in page script (callbackURL honoring):**

After successful email/password sign-in, if `callbackURL` is present in URL params and there's no OAuth redirect (`data.url`), navigate to `callbackURL` instead of reloading. Only honor relative URLs (starting with `/`) to prevent open redirect.

```javascript
if (data.url) {
  window.location.href = data.url;
} else {
  const params = new URLSearchParams(window.location.search);
  const callbackURL = params.get('callbackURL');
  if (callbackURL && callbackURL.startsWith('/')) {
    window.location.href = callbackURL;
  } else {
    window.location.reload();
  }
}
```

The Google button already sets `callbackURL: window.location.href` which preserves the sign-in URL (including `?callbackURL=...`). After Google OAuth completes, the user returns to the sign-in page with a session. Fix 3's server-side check handles this case.

- [ ] Add session gate to `/device` route in app.ts
- [ ] Add session gate to `/consent` route in app.ts
- [ ] Add callbackURL honoring to sign-in page script (email form success path)

---

## Fix 2: Remove dead consent_code data path

**Problem:** `consentCode` prop flows from query validator → renderConsentPage → ConsentPage → hidden input, but the script never reads `#consent-code`. The actual consent identification is via `oauth_query` (signed URL params).

**Fix:**

- Remove `consent_code` from the query validator in app.ts (`type({ 'consent_code?': 'string', ... })`)
- Remove `consent_code: consentCode` from the destructuring in app.ts
- Remove `consentCode` param from `renderConsentPage` in index.tsx
- Remove `consentCode` prop from `ConsentPage` component in consent-page.tsx
- Remove `<input type="hidden" id="consent-code" value={consentCode ?? ''} />` from ConsentPage JSX
- Remove the `consent_code` mention from the JSDoc

- [ ] Remove consent_code from query validator, destructure, and renderConsentPage call in app.ts
- [ ] Remove consentCode prop and hidden input from consent-page.tsx
- [ ] Remove consentCode from renderConsentPage signature in index.tsx

---

## Fix 3: Sign-in page server-side session gate for OAuth re-entry

**Problem:** When a user returns from Google OAuth callback to `/sign-in?client_id=...&sig=...`, they may already have a session (Google callback set the cookie). But the sign-in page unconditionally renders the form. The user sees a sign-in form instead of continuing the OAuth flow.

Also, if a user returns to `/sign-in?callbackURL=...` with a session (e.g., after Google OAuth for a non-OAuth redirect), they see the form unnecessarily.

**Fix (app.ts):**

```typescript
app.get('/sign-in', async (c) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (session) {
    const url = new URL(c.req.url);
    // OAuth re-entry: signed params present → continue the OAuth authorize flow
    if (url.searchParams.has('sig')) {
      return c.redirect('/auth/oauth2/authorize' + url.search);
    }
    // Post-signin redirect: callbackURL present → go there
    const callbackURL = url.searchParams.get('callbackURL');
    if (callbackURL && callbackURL.startsWith('/')) {
      return c.redirect(callbackURL);
    }
  }
  return c.html(renderSignInPage());
});
```

This makes the Google OAuth round-trip reliable: Google callback → sets session → redirects to sign-in page → server sees session + sig → redirects to authorize → flow completes.

- [ ] Add session gate to `/sign-in` route in app.ts (sig check + callbackURL check)

---

## Fix 4: Extract inline scripts to separate files

**Problem:** Three page scripts (~130, ~60, ~70 lines) live inside `raw()` template literals with zero type checking, linting, or greppability.

**Fix:** Create `apps/api/src/auth-pages/scripts/` with one file per page:

- `scripts/sign-in.ts`: exports `SIGN_IN_SCRIPT` (the `raw()` string)
- `scripts/consent.ts`: exports `CONSENT_SCRIPT`
- `scripts/device.ts`: exports `DEVICE_SCRIPT`

Each page component imports from its script file instead of defining the script inline. No runtime behavior change: still inline `<script>` tags, no build step.

- [ ] Create scripts/sign-in.ts, scripts/consent.ts, scripts/device.ts
- [ ] Move each script constant to its respective file
- [ ] Update imports in sign-in-page.tsx, consent-page.tsx, device-page.tsx

---

## Fix 5: Modernize var/ES5 to const/let/arrow

**Problem:** Scripts use `var`, `function(){}`, and `getElementById`: unnecessary for developers running OAuth flows in modern browsers. Block scoping via `const`/`let` prevents accidental hoisting bugs.

**Fix (applied during Fix 4 extraction):**

- `var` → `const` (or `let` where reassigned)
- `function(){}` → arrow functions
- `querySelector`/`querySelectorAll` where it improves clarity (e.g., `document.querySelector('#msg')` vs `document.getElementById('msg')`: keep `getElementById` where it's clear enough)

This is done as part of the script extraction (Fix 4) since we're already touching every line.

- [ ] Convert var → const/let in all three scripts
- [ ] Convert function(){} → arrow functions in all three scripts

---

## Fix 6: Remove redundant scope hidden input from consent page

**Problem:** `<input type="hidden" id="scope" value={scope}>` is read by the script as a separate body field, but scope is already inside `oauth_query` (signed URL params).

**Fix:**

- Remove `<input type="hidden" id="scope" ...>` from ConsentPage JSX
- In consent script: read scope from URL params instead: `new URLSearchParams(window.location.search).get('scope') || ''`
- Keep `scope` prop on ConsentPage for the permissions UI display (the `<ul class="scope-list">` still needs it)

- [ ] Remove scope hidden input from consent-page.tsx
- [ ] Update consent script to read scope from URL params

---

## Commit plan

Each fix is a separate commit:

1. `fix(api): gate /device and /consent routes on auth, honor callbackURL on sign-in`
2. `refactor(api): remove dead consent_code prop and hidden input`
3. `fix(api): redirect authenticated users past sign-in on OAuth re-entry`
4. `refactor(api): extract inline auth page scripts to separate files`
5. `refactor(api): modernize auth page scripts to const/let and arrow functions` (combined with Fix 4 if cleaner)
6. `refactor(api): remove redundant scope hidden input from consent page`

Fixes 4+5 can be combined into one commit since modernization happens naturally during extraction.

---

## Review

All 6 fixes implemented in 5 commits (fixes 4+5 combined):

| Commit | Fix | Files changed |
|--------|-----|---------------|
| `7049f3f` | Gate /device + /consent on auth, honor callbackURL | app.ts, sign-in-page.tsx |
| `3fe7393` | Remove dead consent_code prop/hidden input | app.ts, index.tsx, consent-page.tsx |
| `5b1d366` | Redirect authenticated users past sign-in on OAuth re-entry | app.ts |
| `673006b` | Extract inline scripts + modernize to const/let/arrows | 3 new scripts/*.ts + 3 page components |
| `03f674d` | Remove redundant scope hidden input | consent-page.tsx, scripts/consent.ts |

**Session check pattern**: All three auth page routes now use `c.var.auth.api.getSession({ headers: c.req.raw.headers })` matching the existing `authGuard` middleware pattern.

**Open redirect prevention**: `callbackURL` is only honored when it starts with `/` (relative URLs only).

**OAuth re-entry flow**: `/sign-in` checks session + `sig` param and redirects to `/auth/oauth2/authorize` with the original signed query string, letting Better Auth's authorize endpoint handle the rest.

**No dead code remaining**: `consent_code` hidden input, `consentCode` prop, and `scope` hidden input all removed. Scope is now read from URL search params in the consent script.

**Zero type errors**: `lsp_diagnostics` clean across all 18 .ts/.tsx files in apps/api/src/.
