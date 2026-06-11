# Handoff: execute the encryption-keys clean-break spec

## What you are doing

Execute the spec at
`specs/20260506T183459-encryption-keys-clean-break.md`. It is a hard rename
and hard delete; there is **no backwards compatibility**. The user does not
want shims, aliases, or `// removed` comments.

## One-sentence outcome

```txt
A workspace's only auth dependency is a lazy `encryptionKeys: () => EncryptionKeys`
callback; every other identity check (boundary fail-fast, post-construction
tripwire, browser reload-on-change) is one helper or one inline subscription.
```

## Repo context

- Monorepo. Use `bun`, not npm/pnpm/yarn. `bun run`, `bun test`, `bun install`.
- Branch: `feat/encrypted-local-workspace-storage`. Stay on it.
- Style: no em/en dashes anywhere (prose, comments, JSDoc, errors). Use a
  colon, semicolon, parenthesis, or sentence break.
- Skills available: load `cohesive-clean-breaks`, `refactoring`,
  `incremental-commits`, `git`, `post-implementation-review` if the harness
  exposes them.

## Execute the waves in order

The spec contains six waves. Each wave is its own commit. Do not batch waves.
Order matters: wave 3 needs wave 1's helper; waves 5 and 6 need waves 1-4 done.

```txt
WAVE 1: Move requireSignedIn to @epicenter/auth
WAVE 2: createMachineAuthClient throws on null session
WAVE 3: Daemons/scripts use requireSignedIn
WAVE 4: getKeys → encryptionKeys in attachEncryption + all callers
WAVE 5: Inline auth lifecycle in opensidian/tab-manager; decouple registerDevice
WAVE 6: Delete @epicenter/auth-workspace; update docs
```

For each wave:

1. Read the spec section for the wave.
2. Make the edits.
3. Run `bun run typecheck` at the monorepo root (or per-package if cheaper).
   Resolve errors before continuing.
4. If the wave touches encryption logic (waves 2, 4), run
   `bun test packages/workspace packages/auth packages/encryption`.
5. Commit using conventional commits, prefix `refactor:` or `chore:` as
   appropriate. One commit per wave.

## Hard rules

- **No aliases.** When you rename `getKeys` → `encryptionKeys`, every old
  reference is gone. No `// renamed from getKeys` comments.
- **Delete, don't deprecate.** `@epicenter/auth-workspace` package is gone
  by the end. Delete its directory. Drop its dependency from every app's
  package.json. Run `bun install` to update the lockfile.
- **One wave, one commit.** Verifies isolate cleanly.
- **No new comments unless WHY is non-obvious.** The spec already explains
  why; the code should not need to repeat it.
- **Follow the file list in the spec exactly.** If you discover an unlisted
  file references `getKeys` / `bindAuthWorkspaceScope` / `@epicenter/auth-workspace`,
  update it but flag it in the commit message body so the spec can be amended.
- **`examples/notes-cross-peer/notes.ts` and `packages/cli/README.md:170`**
  are known unlisted sites: the example calls `createMachineAuthClient` for
  bearer-only sync, and the README has a missing `await`. Spec accepts these:
  the example fails fast (correct, since unauthenticated sync 401s anyway),
  and the README typo is a parallel-track fix you may include if you spot it.

## What to skip

- Documentation rewrites beyond the three files listed in wave 6
  (`docs/encryption.md`, `docs/guides/consuming-epicenter-api.md`,
  `.agents/skills/auth/SKILL.md`).
- Re-architecting tab-manager's `registerDevice` beyond the spec's
  decoupling (just fire it once on `idb.whenLoaded`). A future heartbeat
  scheduler is out of scope.
- Anything called out under "Out of scope" in the spec.

## Verification at the end

After wave 6:

```txt
1. `grep -rn "getKeys\b" packages apps playground` → zero matches anywhere
   (including tests; the test files were renamed in wave 4).
2. `grep -rn "bindAuthWorkspaceScope\|@epicenter/auth-workspace"` → zero
   matches outside historical specs.
3. `grep -rn "if (auth.state.status !== 'signed-in')"` in app daemon/script
   files → zero matches; the boundary check now lives in
   createMachineAuthClient and requireSignedIn.
4. `grep -rn "from '@epicenter/auth-svelte'" | grep requireSignedIn` →
   zero matches; every requireSignedIn import is from `@epicenter/auth`
   (or `@epicenter/auth/node` for daemon/script files).
5. `bun run typecheck` at the root → clean.
6. `bun test` → green for `packages/workspace packages/auth packages/encryption`.
7. Optional: load the post-implementation-review skill and run its
   second-read protocol over the changed files. Report any drift.
```

## On grilling

If a question in the spec is genuinely ambiguous, **stop and ask**: do not
guess. The spec was stress-tested by a grilling pass before handoff;
remaining ambiguities are signals the design is incomplete, not invitations
to improvise.

## Final report

Write a short summary in your final message:

- What landed (one line per wave).
- Any deviations from the spec and why.
- Any unlisted files you touched.
- Test/typecheck status.
