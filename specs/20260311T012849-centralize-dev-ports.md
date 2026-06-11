# Centralize Dev Ports as Single Source of Truth

## Problem

Dev ports are duplicated across `packages/constants/src/apps.ts` and individual vite/wrangler configs with no compile-time guarantee they stay in sync. Changing a port in one place silently breaks the other.

Hardcoded consumers today:

| Location | Ports |
|---|---|
| `packages/constants/src/apps.ts` | 8787, 5173, 1420 |
| `apps/whispering/vite.config.ts` | 1420 (server), 1421 (HMR) |
| `apps/whispering/src-tauri/tauri.conf.json` | 1420 (`devUrl`): JSON, can't import TS |
| `apps/epicenter/vite.config.ts` | 1421 (server), 1422 (HMR) |

## Solution

Single `ports.ts` file. URLs and vite configs derive from it.

```
ports.ts (define once) → apps.ts (derive URLs) → vite configs (consume ports)
```

## TypeScript Improvements

1. **`as const satisfies`** on PORTS: preserves literal number types while validating shape
2. **`as const satisfies`** on apps return: preserves literal URL strings while validating every app has a `URL`
3. **Derive `AppId` from PORTS keys**: if you add a port but forget the app entry (or vice versa), TypeScript errors

## Changes

- [ ] **Create `packages/constants/src/ports.ts`**: single source of truth for dev ports
- [ ] **Add `./ports` subpath export** to `packages/constants/package.json`
- [ ] **Update `packages/constants/src/apps.ts`**: import PORTS, derive localhost URLs, add `as const satisfies` with derived `AppId`
- [ ] **Update `apps/whispering/vite.config.ts`**: import `PORTS.AUDIO` for server port
- [ ] **Update `packages/constants/README.md`**: document the ports export
- [ ] **Typecheck**: verify everything compiles

## Out of Scope

- `apps/whispering/src-tauri/tauri.conf.json`: JSON can't import TS; stays hardcoded, documented as known duplication
- `apps/epicenter/vite.config.ts`: uses port 1421 which has no cross-app URL reference in `apps.ts`; no benefit to centralizing unless we add an `EPICENTER` entry later
- Spec files and READMEs with hardcoded URLs: docs, not runtime code
