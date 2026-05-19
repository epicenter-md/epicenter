# Shared Result Test Helpers

Date: 2026-05-19
Status: planned
Owner: Braden

## 1. Context

Tests across the repo often work with `wellcrafted/result` values:

```ts
const { data, error } = await client.handleCallback(url);

expect(error).toBeNull();
expect(data?.accessToken).toBe('access-token');
```

The runtime assertion is fine, but TypeScript does not learn from `expect(error).toBeNull()`. The optional chain is a type workaround, not part of the test's claim. The test means "this result is Ok, now inspect the data."

The same pattern appears on error paths:

```ts
const { error } = await resolveBearerIdentity(args);

expect(error?.name).toBe('InvalidToken');
```

That test means "this result is Err, now inspect the error." Optional chaining weakens the assertion shape and makes later property checks harder to narrow.

## 2. Current Evidence

Grep pass on 2026-05-19:

```sh
rg "expect\([^)]*error[^)]*\)\.toBeNull\(\)" apps packages -g "*.test.ts" -n
```

Result: `52` matches.

```sh
rg "const \{ data, error \}|const \{ error, data \}|const \{ data: [^,}]+, error \}|const \{ error, data: [^,}]+ \}" apps packages -g "*.test.ts" -n
```

Result: `24` matches.

```sh
rg "result\.data\?\.|data\?\." apps packages -g "*.test.ts" -n
```

Result: `22` matches. Some are not `Result` values, so each hit needs review.

```sh
rg -U "expect\((?:error|result\.error|[a-zA-Z]+\.error)\)\.toBeNull\(\);\n(?:.*\n){0,6}.*(?:data|result\.data|[a-zA-Z]+\.data)\?\." apps packages -g "*.test.ts" -n
```

Result: `18` likely success-path `Result` matches.

Existing precedent:

```ts
function expectOk<T>(result: Result<T, unknown>): T {
	expect(result.error).toBeNull();
	if (result.error !== null) throw result.error;
	return result.data as T;
}
```

This already exists locally in `packages/cli/src/commands/up.test.ts` and `apps/api/src/sync-handlers.test.ts`.

## 3. Target State

Use one shared test-only helper module:

```ts
import { expectErr, expectOk } from '@epicenter/test-utils/result';

const data = expectOk(await client.handleCallback(url));
expect(data.accessToken).toBe('access-token');

const error = expectErr(await resolveBearerIdentity(args));
expect(error.name).toBe('InvalidToken');
```

The helpers should do one thing: convert a `Result<T, E>` into the branch the test claims it expects.

```txt
Result<T, E>
   │
   ├─ expectOk(result)  -> T
   │
   └─ expectErr(result) -> E
```

Do not add helper variants for specific domain unions, such as `expectEffectAction`. Those are too narrow. Domain-specific narrowing should stay inline:

```ts
const effect = expectOk(applyMessage(args));

expect(effect?.action).toBe('broadcast');
if (effect?.action !== 'broadcast') {
	throw new Error('Expected broadcast effect');
}

expect(effect.learnedClientIDs).toEqual([clientID]);
```

`expectOk` unwraps the `Result`. It does not prove that nullable success data is present. If a function returns `Result<T | null, E>`, the test still needs to assert the `null` contract or narrow the value.

## 4. Placement Decision

Create a new private workspace package:

```txt
packages/test-utils/
  package.json
  tsconfig.json
  src/
    result.ts
```

Package name:

```json
"name": "@epicenter/test-utils"
```

Export:

```json
"exports": {
  "./result": "./src/result.ts"
}
```

Why not `@epicenter/workspace/test-utils`: auth, API, and CLI tests should not import the workspace package just to unwrap a `Result`. That creates the wrong dependency direction and makes a test helper look domain-owned.

Why not a root `test-utils/` folder: package tests already resolve workspace packages through package exports. A private workspace package gives the helper a stable import path, clear ownership, and no relative path churn.

Why not put it in `wellcrafted`: this is a Bun test assertion helper, not a result primitive. It imports `expect` from `bun:test`, so it belongs in test-only project code.

## 5. Helper Contract

Implement only these exports:

```ts
import { expect } from 'bun:test';
import type { Result } from 'wellcrafted/result';

export function expectOk<T>(result: Result<T, unknown>): T {
	expect(result.error).toBeNull();
	if (result.error !== null) throw result.error;
	return result.data;
}

export function expectErr<E>(result: Result<unknown, E>): E {
	expect(result.error).not.toBeNull();
	if (result.error === null) throw new Error('Expected Err result');
	return result.error;
}
```

Prefer returning without casts. If TypeScript fails to narrow the generic `Result`, use the smallest cast inside the helper and nowhere else.

Do not add:

```ts
expectResultName(...)
expectValidationFailed(...)
expectEffectAction(...)
```

Those hide domain behavior. Use `expectErr` or `expectOk`, then write the domain assertion in the test.

## 6. Implementation Plan

### Phase 1: Add The Package

- [ ] **1.1** Create `packages/test-utils/package.json` with `@epicenter/test-utils`, private package metadata, an export for `./result`, and scripts for `typecheck` and `test` if needed.
- [ ] **1.2** Create `packages/test-utils/tsconfig.json` extending the repo base config and including `src/**/*.ts`.
- [ ] **1.3** Create `packages/test-utils/src/result.ts` with `expectOk` and `expectErr`.
- [ ] **1.4** Run `bun run --cwd packages/test-utils typecheck`.

### Phase 2: Wire Consumers

- [ ] **2.1** Add `@epicenter/test-utils: workspace:*` as a `devDependency` to every package or app whose tests import it.
- [ ] **2.2** Start with the packages already known to need it: `apps/api`, `packages/auth`, `packages/cli`, and `packages/workspace`.
- [ ] **2.3** Do not add it to packages that do not import it.

### Phase 3: Migrate Existing Local Helpers

- [ ] **3.1** Replace the local `expectOk` in `packages/cli/src/commands/up.test.ts` with the shared import.
- [ ] **3.2** Replace the local `expectOk` in `apps/api/src/sync-handlers.test.ts` with the shared import.
- [ ] **3.3** Keep the current inline `effect.action` narrowing in `sync-handlers.test.ts`; do not introduce `expectEffectAction`.

### Phase 4: Migrate Success Paths

Use this shape:

```ts
const result = await operation();
const data = expectOk(result);
expect(data.value).toBe(expected);
```

or inline when it reads cleanly:

```ts
const data = expectOk(await operation());
expect(data.value).toBe(expected);
```

Targets from the current grep:

- [ ] **4.1** `packages/auth/src/oauth-launchers/index.test.ts`: replace success-path `data?.` checks after `expect(error).toBeNull()`.
- [ ] **4.2** `apps/api/src/auth/resource-boundary.test.ts`: replace success-path `data?.` checks after `expect(error).toBeNull()`.
- [ ] **4.3** `packages/auth/src/node/oob-launcher.test.ts`: replace `result.data?.accessToken` after `expect(result.error).toBeNull()`.
- [ ] **4.4** `packages/auth/src/node/machine-auth.test.ts`: replace `result.data?.identity` and `result.data?.status` after `expect(result.error).toBeNull()`.
- [ ] **4.5** `packages/workspace/src/document/dispatch.test.ts`: replace `result.data?.closed` after `expect(result.error).toBeNull()`.
- [ ] **4.6** Review `packages/workspace/src/document/create-table.test.ts` hits where tests destructure only `data`. If the test assumes an Ok result, migrate to `expectOk`.

### Phase 5: Migrate Clear Error Paths

Use this shape:

```ts
const error = expectErr(await operation());
expect(error.name).toBe('InvalidToken');
```

For discriminated error variants, keep the explicit guard:

```ts
const error = expectErr(result);
expect(error.name).toBe('ValidationFailed');
if (error.name !== 'ValidationFailed') {
	throw new Error('Expected ValidationFailed');
}
expect(error.issues.length).toBeGreaterThan(0);
```

- [ ] **5.1** Migrate simple `error?.name` assertions where the full `Result` value can be kept.
- [ ] **5.2** Leave non-Result optional chains alone, such as array indexing, captured fetch `init?.body`, map lookups, and mock callback arguments.
- [ ] **5.3** Do not rewrite error checks where optional chaining is documenting real absence instead of compensating for a Result branch.

## 7. Verification

Run formatting, typechecks, and focused tests:

```sh
bun x biome check --write --linter-enabled=false packages/test-utils apps/api packages/auth packages/cli packages/workspace
bun run --cwd packages/test-utils typecheck
bun run --cwd apps/api typecheck
bun run --cwd packages/auth typecheck
bun run --cwd packages/workspace typecheck
bun test apps/api/src/sync-handlers.test.ts
bun test packages/auth/src/oauth-launchers/index.test.ts packages/auth/src/node/oob-launcher.test.ts packages/auth/src/node/machine-auth.test.ts
bun test packages/workspace/src/document/dispatch.test.ts packages/workspace/src/document/create-table.test.ts
```

Then run the no-straggler checks.

Success-path stragglers:

```sh
rg -U "expect\((?:error|result\.error|[a-zA-Z]+\.error)\)\.toBeNull\(\);\n(?:.*\n){0,6}.*(?:data|result\.data|[a-zA-Z]+\.data)\?\." apps packages -g "*.test.ts" -n
```

Expected result: no matches, unless a match is explicitly documented in the final report as not a `Result` branch.

Local helper stragglers:

```sh
rg "function expectOk|function expectErr|const expectOk|const expectErr" apps packages -g "*.test.ts" -n
```

Expected result: no local definitions outside `packages/test-utils/src/result.ts`.

Broad review scan:

```sh
rg "result\.data\?\.|data\?\.|result\.error\?\.|error\?\." apps packages -g "*.test.ts" -n
```

Expected result: remaining matches are either non-Result optional chains, nullable success data that is intentionally nullable, or error-shape checks that need a domain guard and were deliberately left for a follow-up.

If the focused no-straggler checks pass, the implementation report should include:

1. The number of migrated `expectOk` call sites.
2. The number of migrated `expectErr` call sites.
3. Any remaining broad-scan optional chains, grouped by reason.
4. A short recommendation for the next cleanup scope if the broad scan shows another repeated pattern.

## 8. Non-goals

- Do not create a custom matcher API.
- Do not add global Bun expect extensions.
- Do not add domain-specific unwrap helpers.
- Do not migrate non-Result optional chaining.
- Do not change production `Result` APIs.
- Do not move package-local test setup helpers into `@epicenter/test-utils` unless they are Result-related.

## 9. Stop Conditions

Stop when:

1. `expectOk` and `expectErr` live in one shared test-only package.
2. Existing local `expectOk` helpers are gone.
3. Success-path `expect(error).toBeNull()` plus `data?.` patterns are gone or explicitly justified.
4. Focused test and typecheck commands pass.
5. The final report lists remaining broad optional-chain matches instead of pretending they do not exist.
