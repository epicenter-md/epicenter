# Why Epicenter Uses Numbers Instead of Semantic Versioning

In Epicenter, workspace versions are just numbers: 1, 2, 3, 4.

Not semantic versions like "1.0.0" or "2.1.3". Just plain old integers.

## The Decision

We had a choice between semantic versioning (semver) and plain version numbers. We chose plain numbers.

## Why Not Semver?

Semantic versioning is powerful for libraries and packages:
- **Major**: breaking changes
- **Minor**: new features, backwards compatible
- **Patch**: bug fixes

But for workspace configurations, this is overkill.

## The Reality of Workspace Changes

When you change a workspace, you're typically:
- Adding or removing columns from the schema
- Changing action signatures
- Modifying data structures

**These are all breaking changes.**

There's no such thing as a "backwards compatible schema change" when your data structure evolves. There's no "patch" for a workspace configuration.

Every meaningful change is breaking. Every change requires a version bump. The three-tier semver system doesn't map to reality.

## What Plain Numbers Give Us

**Simplicity**: Users just increment. No thinking about major vs minor vs patch.

```typescript
// Version 1
const workspace = defineWorkspace({
  id: 'blog',
  version: 1,
  // ...
});

// Made changes? Bump it.
const workspace = defineWorkspace({
  id: 'blog',
  version: 2,
  // ...
});
```

**Accessibility**: Easier mental model. Version 3 is newer than version 2. That's it.

**Simpler comparison**: No need for semver comparison libraries. Just use `>`:

```typescript
if (wsVersion > existingVersion) {
  // Use the newer one
}
```

**Honest types**: The type system says `number`, the code uses `number`. No ceremony converting strings to numbers.

## The Tradeoff

Yes, we lose the semantic information that semver provides. We can't tell if v2 to v3 was a "major" breaking change or a "minor" feature addition.

But we decided this information isn't valuable enough to justify the complexity. Every workspace change is effectively major. Pretending otherwise creates confusion.

## When Semver Makes Sense

For published libraries consumed by thousands of developers, semver is essential. It communicates compatibility and helps dependency resolution.

But workspace configs in Epicenter are:
- Local to your project
- Typically managed by you or your team
- Changed infrequently
- Always breaking when they do change

In this context, plain numbers win.

## The Bottom Line

Epicenter uses numbers because workspace versioning is simpler than library versioning. One number is enough to track "this changed." Adding two more numbers would be ceremony without benefit.

Keep it simple. Increment and move on.
