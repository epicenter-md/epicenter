# Actions are passthrough; transport wraps

**Date:** 2026-04-25
**Status:** shipped (commits `2be551876` add invokeNormalized; `81cd627ee` makes defineMutation/defineQuery passthrough)
**Supersedes:** the "always-async, always-Result" decision in `specs/20260424T180000-drop-document-factory-attach-everything.md` (lines 176-240, 251-252) and the now-deleted Phase 1 execution prompt's § Change 5 (executed in commits `fd3a1ce8d` through `88ef425b1`, then walked back to passthrough by this ADR's `2be551876` + `81cd627ee`).

## TL;DR

`defineMutation` / `defineQuery` become **pure passthrough**: the returned action callable IS the handler, with metadata attached. Local callers see the handler's actual return shape (sync if sync, raw if raw, `Result` if explicit). Transport-imposed semantics (`Promise<Result<T, E | RpcError>>`) live at the boundary that has the transport: `createRemoteActions` for the wire, plus a single shared `invokeNormalized` util for in-process consumers (AI bridge, CLI, RPC server-side).

## Context

Phase 1 (PR landing now) implemented "actions always return `Promise<Result<T, E>>`." The spec author's reasoning:
1. Unified shape across local, AI, CLI, RPC consumption.
2. Eliminates the `RemoteReturn` conditional type machinery.
3. "Two semantic worlds": handler-shape locally vs wrapped remotely: was hard to reason about.

After implementing, the costs are visible at four Fuji fire-and-forget UI sites that touch operations which genuinely cannot fail (pure Y.Doc writes). Those sites pay an async + Result envelope tax forever, for capabilities the operations don't need locally. The wrap was put at definition time to support remote/AI/CLI consumers; local UI inherited that cost as collateral.

An audit (this PR) measured the actual exposure:

| Category | Sites | Migration cost |
|---|---|---|
| App invocation sites depending on the wrap | 3 | Simplify destructure |
| Fire-and-forget sites paying the `void` tax | 4 | Drop `void` |
| Framework boundaries depending on wrap (need normalize) | 2 (tool-bridge, cli/run) | Adopt shared util |
| Framework boundaries that already normalize correctly | 2 (handleRpcRequest, makeLeaf) | None |
| Test sites destructuring `.data` from raw-handler actions | ~26 | Drop `.data` |
| `RemoteActions<A>` mapped type | 1 | 4-branch conditional |

Total surface: ~40 mechanical changes in two phases.

## Decision

**`defineMutation` and `defineQuery` are passthrough.** They attach metadata to the handler and return it; the callable signature is the handler's signature.

```ts
function defineMutation({ handler, ...meta }) {
  return Object.assign(handler, { type: 'mutation' as const, ...meta });
}
```

**Transport-imposed semantics live at boundaries:**

- `createRemoteActions(actions, send)`: already wraps each leaf in `Promise<Result<T, E | RpcError>>`. The mapped type `RemoteActions<A>` uses a 4-branch `WrapAction<F>` conditional that handles sync raw, sync Result, async raw, and async Result handler shapes.
- `attach-sync.ts:handleRpcRequest`: already normalizes raw → `Ok`, throw → `Err(ActionFailed)`. Unchanged.
- `tool-bridge.ts:execute` and `cli/run.ts:invokeLocal`: adopt a shared `invokeNormalized(action, input)` util that does the same normalize work uniformly.

The shared util:

```ts
// packages/workspace/src/shared/actions.ts
export async function invokeNormalized<T = unknown>(
  action: Action,
  input?: unknown,
): Promise<Result<T, RpcError>> {
  try {
    const ret =
      action.input !== undefined ? await action(input) : await action();
    return isResult(ret) ? ret : Ok(ret);
  } catch (cause) {
    return RpcError.ActionFailed({
      action: 'unknown',
      cause,
    });
  }
}
```

Three call sites use it: AI tool bridge, CLI dispatch, and (optionally) `handleRpcRequest` if we want to centralize. This converts three slightly-different inline normalizers into one canonical implementation.

## Rationale

### 1. Transport semantics belong at the transport layer

`Promise<Result<T, E | RpcError>>` exists because the wire is async (so `Promise`) and can fail in transit (so `Result`, error union widened by `RpcError`). Same-process calls don't have those constraints. Baking transport semantics into the function definition put the concern at the wrong layer.

This aligns with how analogous systems work:
- **tRPC**: server procedures are plain async functions; the *client proxy* introduces `Promise` (network is async).
- **TanStack Query**: mutation function returns whatever it returns; `mutate` and `mutateAsync` are wrappers added by the *consumer hook*.
- **gRPC**: server handlers are sync or async; the generated *client* knows it's network and wraps.

### 2. Type-system migration is safer than silent semantic absorption

In passthrough world, if `entries.update` later changes from sync void to async `Result<T, E>`:
- All call sites light up red in TypeScript ("can't destructure a Promise", "cannot read `.id` on `Result`").
- The fix is mechanical and surgical: every site is identified by the type checker.

In unified world, the same handler change:
- All call sites keep working.
- A site that should now toast an error keeps `void`-ing past it.
- The migration is silent; nothing tells you what changed and where.

I argued in the original spec that unified protects call sites from migration. Re-examining: silent absorption is *worse* than visible migration for a system that's evolving. Visible failures get fixed.

### 3. The "two semantic worlds" objection doesn't apply to this design

The spec's complaint was about *implicit* conditional types (`RemoteReturn`) that silently rewrote the shape based on whether the caller was local or remote. Authors couldn't tell what shape they'd see without tracing through the conditional.

This design makes the boundaries explicit. `actions.X` is the handler shape. `createRemoteActions(actions, send).X` is the wrapped shape. The factory name tells you which world you're in. That's not the bad kind of "two worlds". It's two clearly-labeled APIs with different responsibilities.

### 4. The unified wrap doesn't actually save consumers work

I argued in the original spec that AI/CLI/RPC consume actions locally and need uniform `Promise<Result>`, so wrapping at definition saves them all from normalizing themselves. In practice, those consumers still have to:
- Check `result.error !== null` and handle the Err case
- Convert thrown errors to typed errors
- Handle their domain-specific output transformations

The wrap saves a shape-detection branch but not the error handling. Boundary normalize is a few lines per site, and centralizing them in `invokeNormalized` is strictly cleaner than three slightly-different inline implementations.

### 5. Authors write natural code

In passthrough, the action's signature reflects what the handler does. Sync if sync, async if async, raw if raw, `Result` if `Result`. The author thinks about their handler's semantics, not about transport contracts. The type system reflects what they wrote. Consumers see what's there.

## Trade-offs accepted

### Throws in handlers reach local callers

If a handler unexpectedly throws (logic bug, not designed failure), the error propagates to the local caller. UI sites that don't `try/catch` may crash visibly. RPC and AI bridge still convert to `Err(ActionFailed)` at their boundaries.

This is the same as any function in JavaScript. Designed failures should be explicit `Err`. Unexpected throws crashing visibly is preferable to silent absorption: bugs get noticed and fixed.

### Two callable shapes depending on entry point

`actions.X` has handler shape. `createRemoteActions(actions, send).X` has wrapped shape. Authors don't decide; consumers pick the factory that matches their needs.

This is honest, not hidden. The factory choice is the boundary marker.

### Conditional types in `RemoteActions<A>`

`WrapAction<F>` is a 4-branch flat conditional (sync raw, sync `Result`, async raw, async `Result`) that derives the wrapped shape from the handler signature. This brings back something `RemoteReturn`-shaped, although structurally simpler: flat, not recursive.

```ts
type WrapAction<F> = F extends (...a: infer A) => infer R
  ? R extends Promise<infer Inner>
    ? Inner extends Result<infer T, infer E>
      ? (...a: A) => Promise<Result<T, E | RpcError>>
      : (...a: A) => Promise<Result<Inner, RpcError>>
    : R extends Result<infer T, infer E>
      ? (...a: A) => Promise<Result<T, E | RpcError>>
      : (...a: A) => Promise<Result<R, RpcError>>
  : never;
```

Acceptable. It's idiomatic TypeScript, lives in one file, isolated.

## Migration plan

Phased commits, each independently green. Workspace package first (foundation), apps second.

### Phase A: Workspace package

**A1. Add `invokeNormalized`** in `packages/workspace/src/shared/actions.ts`. Export from barrel. Tests in same file.

**A2. Make `defineMutation` / `defineQuery` passthrough.** Drop the `async ... normalize(await ...)` wrap; just attach metadata.

**A3. Update `RemoteActions<A>` mapped type** with `WrapAction<F>` 4-branch conditional. Verify `createRemoteActions(actions, send)` types still resolve correctly for explicit-Result and raw-returning leaves.

**A4. Update `tool-bridge.ts:execute`** to call `invokeNormalized(action, args)` instead of `await invoke + .data/.error` direct read.

**A5. Update `cli/run.ts:invokeLocal`** same way.

**A6. Update workspace tests:**
- Materializer markdown test: ~18 sites drop `.data!`.
- Materializer sqlite test: 5 sites drop `.data`.
- `tool-bridge.test.ts`: no changes (tests `tool.execute()` directly).
- `attach-sync.test.ts`: no changes (tests transport boundary).
- `remote-actions.test.ts`: no changes (tests proxy normalize independently).

**A7. Update CLI test:** `e2e-inline-actions.test.ts` 3 sites drop `.data`.

After Phase A: `bun test packages/workspace` and `bun test packages/cli` green; `bunx tsc --noEmit -p packages/workspace` clean.

### Phase B: Apps

**B1. Fuji `entries-state.svelte.ts:78`:** simplify destructure (raw handler returns `{id}`).

```ts
// before
const { data, error } = await workspace.actions.entries.create({});
if (error) throw error;
goto(`/entries/${data.id}`);

// after
const { id } = await workspace.actions.entries.create({});
goto(`/entries/${id}`);
```

**B2. Opensidian `skill-state.svelte.ts:55,59`:** drop `{ data, error }` destructure on `listSkills` and `getSkill`. Net 4 lines deleted.

**B3. Drop `void` keyword from Fuji fire-and-forget sites** (cosmetic, not required for correctness): `EntryEditor.svelte:36,64`, `BulkAddModal.svelte:63`, `trash/+page.svelte:78`.

After Phase B: `bunx tsc --noEmit -p apps/fuji`, `apps/opensidian`, `apps/honeycrisp`, `apps/tab-manager` clean (modulo unrelated pre-existing errors).

### Phase C: Verification

- `bun test packages/workspace`: 541+ tests pass.
- `bun test packages/cli`: 69 tests pass.
- Manual: open Fuji SPA, create / update / delete entries, two-tab sync still works.
- Manual: tab-manager extension AI tool execution still resolves typed errors.

### Rollback

Each phase is independently revertible by `git revert`. The riskiest phase is A2 (defineMutation passthrough): if downstream type errors are unmanageable, revert A2 + A3 + A6 + A7 and keep the audit findings as documentation. Phases A1, A4, A5, B1, B2, B3 are independently safe. They just shift code around with no behavior change.

## Open questions

**`isResult` re-export from `@epicenter/workspace`**: audit shows zero non-framework consumers. Safe to drop. Defer to a follow-up cleanup PR.

**`dispatchAction` error handling**: currently throws on path-not-found. The boundary catches and produces `RpcError.ActionNotFound`. Could return `Result` directly for stricter API. Defer; not blocking this ADR.

**`handleRpcRequest` and `invokeNormalized`**: the RPC server-side handler does its own normalize today. Could be replaced with `invokeNormalized` for consistency, but the inlined version is well-tested and handles the wire-encoding particulars (`encodeRpcResponse`). Leave inline for now; revisit if drift appears.

## Background: earlier formulation (collapsed in from `local-passthrough-remote-result.md`)

Before this ADR was written, the same conclusion had been argued in a separate spec (`20260423T020000-local-passthrough-remote-result.md`, now deleted: its content is preserved here so the reasoning isn't lost). That spec framed the problem as **"two type surfaces, not one"**:

- **Local** (in-process): the action's signature is literally the handler's signature. Sync stays sync. Raw stays raw. Throws throw. Returned `Result` stays `Result`.
- **Remote** (RPC proxy / websocket): always `(input) => Promise<Result<T, E | RpcError>>`. Forced async, forced envelope: because transport demands it.

**Why the v0 unified attempt failed (kept here as institutional memory).** A first pass ("`20260422T234500-unified-action-invocation.md`", strict-Result variant) tried to collapse both onto `Promise<Result<T, E | ActionFailed>>` at definition time. The migration showed the cost: every local caller had to `await` and destructure `{data, error}`: even for handlers that literally cannot fail (`() => tables.posts.getAllValid()`). Most handlers in the codebase genuinely have no error channel. Forcing one on them is ergonomic tax with no safety payoff, because locally you can `try/catch` a throw like any other JS function.

**`ActionFailed` (now `RpcError.ActionFailed`) exists to solve a wire problem**: thrown errors don't cross processes. It doesn't need to exist in the local call graph. The decision in this ADR honors that boundary: definers are passthrough; the wire boundary (`createRemoteActions`) and the in-process consumers that simulate a wire boundary (`invokeNormalized`) are where the envelope shows up.

The earlier spec also noted the analogy to **tRPC** (server procedures are plain async functions; the client proxy introduces `Promise`), **TanStack Query** (mutation function returns whatever it returns; `mutate`/`mutateAsync` are wrappers), and **gRPC** (server handlers are sync or async; the generated client wraps for the wire). All three put transport semantics at the transport layer, not at the definition layer. This ADR adopts the same split.

## Cross-references

- `specs/20260424T180000-drop-document-factory-attach-everything.md`: the original "always-async-Result" decision this ADR supersedes. Lines 176-240 (Change 5 design) and 251-252 (design decision summary).
- ~~`specs/20260425T120000-execution-prompt-phase-1.md`~~: Phase 1 execution prompt, which landed the unified wrap (§ Change 5). Deleted post-merge per the scaffolding-files convention; Phase 1 commits `fd3a1ce8d` through `88ef425b1` are the durable record.
- `specs/20260425T210000-remote-action-dispatch.md`: companion design doc for cross-device action execution. Depends on this ADR landing first.
- ~~`specs/20260423T020000-local-passthrough-remote-result.md`~~: collapsed into the "Background: earlier formulation" section above; file deleted.
