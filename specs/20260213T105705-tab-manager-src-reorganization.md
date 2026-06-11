# Tab Manager `src/` Reorganization

> **Note**: "Suspended" terminology was renamed to "saved" in the codebase. References below use the original names. See `specs/20260213T014300-rename-suspended-to-saved.md`.

Reorganize `apps/tab-manager/src/lib/` from a flat/ad-hoc layout to domain-grouped modules.

## Problem

- `epicenter/browser.schema.ts` (401 lines) mixes 4 concerns: branded ID types, table definitions, composite ID constructors, row converters
- `epicenter/schema.ts` (18 lines) is a pointless re-export wrapper
- `epicenter/index.ts` (10 lines) is a near-dead barrel (1 consumer)
- `device-id.ts` mixes device identity (runtime storage/platform) with composite ID parsing (pure string functions)
- Composite ID functions split across two files (`browser.schema.ts` has constructors, `device-id.ts` has parsers)
- `getDomain()` duplicated in `SuspendedTabList.svelte` and `TabItem.svelte`
- Flat `lib/` mixes state files, schema files, and utilities at one level

## Solution

Group files by domain with one responsibility per file.

### Before

```
lib/
├── browser-state.svelte.ts          # Popup reactive state (Chrome APIs)
├── device-id.ts                     # Device ID + composite ID parsers (mixed)
├── suspended-tab-state.svelte.ts    # Popup reactive state (Y.Doc)
├── components/
│   ├── SuspendedTabList.svelte
│   ├── TabItem.svelte
│   └── TabList.svelte
└── epicenter/
    ├── browser.schema.ts            # 401 lines, 4 concerns
    ├── index.ts                     # Dead barrel
    ├── schema.ts                    # Pointless re-export
    ├── suspend-tab.ts
    └── workspace.ts
```

### After

```
lib/
├── components/                      # UNCHANGED
│   ├── SuspendedTabList.svelte
│   ├── TabItem.svelte
│   └── TabList.svelte
├── device/
│   ├── composite-id.ts              # Branded types + arktype validators + create/parse
│   └── device-id.ts                 # getDeviceId, getBrowserName, generateDefaultDeviceName
├── schema/
│   ├── tables.ts                    # Table definitions + BROWSER_TABLES + type exports
│   ├── row-converters.ts            # tabToRow, windowToRow, tabGroupToRow
│   └── index.ts                     # Barrel: re-exports + BrowserDb type
├── services/
│   └── save-tab.ts                  # Moved from epicenter/, imports updated
├── state/
│   ├── browser-state.svelte.ts      # Moved from lib/, imports updated
│   └── saved-tab-state.svelte.ts
├── utils/
│   └── format.ts                    # getDomain + getRelativeTime (deduplicated)
└── workspace.ts                     # Moved from epicenter/, imports updated
```

## Tasks

- [x] Create directory structure (device/, schema/, services/, state/, utils/)
- [x] Create `lib/device/composite-id.ts`: branded types, arktype validators, create*, parse*
- [x] Create `lib/device/device-id.ts`: device identity only (minus parsers)
- [x] Create `lib/schema/tables.ts`: table definitions, BROWSER_TABLES, type exports
- [x] Create `lib/schema/row-converters.ts`: tabToRow, windowToRow, tabGroupToRow
- [x] Create `lib/schema/index.ts`: barrel re-exports + BrowserDb type
- [x] Create `lib/utils/format.ts`: getDomain, getRelativeTime
- [x] Move + update `lib/services/save-tab.ts`
- [x] Move + update `lib/state/browser-state.svelte.ts`
- [x] Move + update `lib/state/saved-tab-state.svelte.ts`
- [x] Move + update `lib/workspace.ts`
- [x] Update imports in `background.ts`
- [x] Update imports in `TabItem.svelte` + use format utils
- [x] Update imports in `SuspendedTabList.svelte` + use format utils
- [x] Update imports in `TabList.svelte`
- [x] Delete old files (epicenter/, device-id.ts, \*-state.svelte.ts at lib root)
- [x] Verify typecheck passes

## Files Deleted (2 dead, 6 moved)

| File                            | Reason                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `epicenter/schema.ts`           | Pointless 18-line re-export, merged into `schema/index.ts`                            |
| `epicenter/index.ts`            | Dead barrel, 1 consumer switched to `$lib/schema`                                     |
| `epicenter/browser.schema.ts`   | Split into `device/composite-id.ts` + `schema/tables.ts` + `schema/row-converters.ts` |
| `epicenter/save-tab.ts`         | Moved to `services/save-tab.ts`                                                       |
| `epicenter/workspace.ts`        | Moved to `lib/workspace.ts`                                                           |
| `lib/device-id.ts`              | Split: identity → `device/device-id.ts`, parsers → `device/composite-id.ts`           |
| `lib/browser-state.svelte.ts`   | Moved to `state/browser-state.svelte.ts`                                              |
| `lib/saved-tab-state.svelte.ts` | Moved to `state/saved-tab-state.svelte.ts`                                            |

## Review

Pure file reorganization. No logic changes, no API changes. All imports updated mechanically.
