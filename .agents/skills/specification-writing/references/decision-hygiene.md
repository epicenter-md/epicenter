# Decision Hygiene

## When to Read This

Read this when a spec has many trade-offs, migration cleanup, "keep for consistency" decisions, or old code paths that will be replaced and deleted.

The goal is to keep future readers from mistaking evidence, design coherence, and taste for the same kind of decision.

## Decision Classes

Every material decision in a spec falls into one of three classes.

| Class | Decided by | Agent behavior |
| --- | --- | --- |
| 1 | Evidence | Check the source, run a test, verify the version, or inspect the behavior. |
| 2 | Design coherence | Apply the spec thesis consistently. Do not relitigate settled design. |
| 3 | Taste under constraints | Pick deliberately. Name the trade-off and constraint. |

Examples:

```txt
Class 1:
  Does Better Auth's signOut accept custom headers?
  Check the source, write a test, and verify the version.

Class 2:
  Should pending polling states be exposed to callers?
  If the thesis says polling is private, no.

Class 3:
  Keep a typed wrapper for codebase pattern consistency, or drop it for
  cleaner pass-through?
  Choose deliberately and name the constraint.
```

## Failure Modes

### Inertia keep

Class 3 disguised as Class 2.

```txt
"Keep for consistency."
```

This sounds principled, but often means "I have not decided." Future readers assume the choice was load-bearing. If the keep is real, name the use case. If it is churn avoidance, log it as Class 3.

### Unverified deletion

Class 1 disguised as Class 2.

```txt
"The new code is in place, delete the old."
```

That skips verification. The replacement may be coherent and still broken. Verify first, then delete.

## Active Justification Test

Before locking any "keep" decision in the Design Decisions table, ask:

```txt
Would I add this if it did not already exist?
```

Use the answer to classify the keep:

```txt
Yes, here is the use case:
  Class 2 keep. Lock it.

No, but removing it is churn:
  Class 3 keep by inertia. Name it in the Decisions Log.

No, and removing it is not that hard:
  Drop it now.
```

Most "keep for consistency" rationales fail this test.

## Decisions Log

Near the end of the spec, list every Class 3 keep with its constraint and a `Revisit when:` trigger.

```markdown
## Decisions Log

- Keep `InstanceConnectionStatus` as a four-state union: codebase typed-state
  pattern consistency.
  Revisit when: any caller branches on more than connected versus not.
- Module-level singleton auth client: roughly 1 to 2 ms saved per app boot.
  Revisit when: per-call construction profiles become a real concern.
- Narrow capability types per function: prevents accidental launcher coupling
  for sign-out tests.
  Revisit when: type-level overhead exceeds value during maintenance.
```

This makes future reviewers see what is load-bearing and what is deferred.
