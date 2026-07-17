# Greenfield Pass

Run a radical simplification pass on a target. Premise: this code does
not have real users locking its shape in place, so compat shims,
prod-vs-dev special cases, exported helpers nobody imports, "default"
parameters with one real value, and modules that exist only because
their tests exist are paying permanent rent for benefits that are not
real yet. Find them and delete them.

## Inputs

- **Target**: a path or a concept. Can be a folder, a single module, a
  cross-cutting boundary (for example "error handling", "the storage
  layer", "the auth surface"), or a group of files.
- **Stop condition**: when proposed deletions become churn or
  stylistic preference rather than real simplification (default).

## Procedure

1. **Frame.** Read whatever documents anchor the target: README,
   AGENTS.md / CLAUDE.md, any planning doc or ADR referencing it,
   project conventions files. Restate in one sentence what the target
   is FOR. If you cannot, stop and ask.

2. **Audit with the smell catalog.** If the project ships a
   `code-audit` skill or equivalent, load it. Walk the target looking
   for:
   - Dead exports (re-exported but never imported externally).
   - Options used only by tests.
   - Helpers with one production caller.
   - Boundary shape copies (`*Like`, `*Shape`, `*Dto`).
   - Type assertions at boundaries.
   - `Pick`-of-one dep types.
   - `console.*` in library code (if the project bans it).
   - Error variants no caller discriminates on.
   - Default values that read environment state at call time.
   - Modules that exist only because their tests exist (a pure inner
     function paired with a thin wrapper of comparable size).

3. **Radical options pass.** If available, load `radical-options`. For
   each smell, ask:
   - What is the cleanest from-scratch shape, ignoring the current code?
   - What asymmetric wins are available if I refuse 10 to 20 percent of
     the current surface to collapse 80 to 90 percent of complexity?
   - Is this split, option, abstraction, or variant earning its keep?

4. **Greenfield gate.** If available, load `greenfield-clean-breaks`.
   Specifically target:
   - Compat shims for users that do not exist.
   - Fallback branches for migrations that already happened.
   - Prod-vs-dev special cases.
   - Exported helpers that exist only for imagined external callers.
   - "Default" parameters with one real value.

   Default position: **delete them.** The bar to keep one is: there is
   a real user today that breaks AND the migration story is worse than
   the permanent upkeep.

5. **Mentally inline.** For each file in the target, inline every
   helper, wrapper, and extracted function back into its call sites.
   Read the result as if seeing it for the first time. Ask:
   - **Dead paths**: methods, options, or configuration hooks nothing
     calls.
   - **Stale boundaries**: a module split or wrapper that made sense
     earlier but no longer earns its indirection.
   - **Naming**: do names match what the code does, or what it used to
     do? Flag file names too. Does `foo-manager.ts` still manage
     anything, or is it a passthrough?
   - **File organization**: if you could rename, move, merge, or split,
     what would you change? Show the proposed tree alongside the
     current one.

6. **Report before coding.** Produce a before/after ASCII diagram of
   the proposed changes. List:
   - What is deleted.
   - What is renamed.
   - What public API shape changes.
   - What test coverage moves and how.
   - What the new one-sentence rule for the target becomes.

   Then **stop and wait for OK or redirect** before editing.

7. **Implement.** Once OK'd:
   - Stage specific files only. Never `git add .` or `git add -A`.
   - After each commit-sized batch, run the project's focused test and
     typecheck commands (look in `package.json` scripts or the
     equivalent).
   - Use a commit message style matching the project's history
     (conventional commits, plain prose, etc.). Describe the
     asymmetric win: what was deleted versus what was kept.

8. **Post-implementation review.** If available, load
   `post-implementation-review`. Re-read every touched file. For each:
   - **Inline test**: mentally inline every function call and helper.
     Would you draw the same abstraction boundaries, or are some
     wrappers indirection that does not earn its keep?
   - **Smell check**: dead code, redundant operations (for example a
     `mkdir` on every write when dirs exist), unnecessary type casts,
     exported types with zero consumers.
   - **Invariant audit**: assumptions baked into the code that the
     current design no longer guarantees (for example a per-write
     safety check actually handled at setup time).
   - **API shape**: if you were designing this surface from scratch
     with what you know now, would the function signatures, config
     types, or module boundaries look different?

   Flag anything you find before silently fixing. State what is wrong
   and why; let the user OK any follow-up.

9. **Final report.** One paragraph: what was deleted, what was kept
   and why, what compat decisions were made and why, what follow-up
   cleanups you noticed but did not pursue.

## Constraints

- **Customer-facing surfaces are out of scope unless the user
  explicitly opts in.** Anything that has real public users (shipped
  apps, public APIs, published packages) locks behavior; do not
  greenfield it without permission.
- **Follow project conventions.** Check AGENTS.md / CLAUDE.md /
  CONTRIBUTING.md / .cursor/rules / similar for: package manager,
  formatting rules, banned characters (some projects ban em dashes or
  en dashes), logger conventions, branch naming, commit conventions.
  Match what is there.
- **Preserve explicit test overrides.** When removing defaults, keep
  the explicit-argument code path so tests do not get rewritten by
  accident. Remove only the defaults that no production code uses.
- **Stage specific files.** Never `git add .` or `git add -A`. Read
  `git status` between staging and committing to confirm.
- **After any public-API surface change, grep the codebase for
  callers** before claiming the change is internal.
- **No destructive git operations without explicit OK.** No force
  push, no `--hard`, no branch deletion of branches you did not
  create this session.

## Optional skills

These are common in well-maintained TypeScript repos. Load any that
exist; ignore any that do not:

- `code-audit` (smell catalog with calibrated recipes)
- `radical-options` (rethink the shape before coding)
- `greenfield-clean-breaks` (refuse compat shims and execute clean breaks)
- `cohesion-over-testability` (collapse code split only for test reach)
- `collapse-pass` (continuous indirection reduction)
- `refactoring` (per-change mechanics)
- `post-implementation-review` (second-read pass after edits)
- `first-read-review` (first-read sanity check for new readers)

## Output shape

Every greenfield pass ends with three things:

1. A short before/after diagram of what changed.
2. A one-sentence rule the target now follows.
3. A list of follow-up cleanups you spotted but did not pursue, so the
   next pass can pick them up.
