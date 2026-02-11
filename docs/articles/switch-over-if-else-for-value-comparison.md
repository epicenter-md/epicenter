# Switch Over If/Else for Value Comparison

**TL;DR: When multiple branches compare the same variable against constants, use a `switch` statement.** It groups related cases visually, enables fall-through for shared logic, and pairs naturally with exhaustive checking.

> If you're writing `x === 'a'` then `else if (x === 'b')` then `else if (x === 'c')`, you've reinvented a switch statement with more syntax.

## The Problem

This pattern shows up constantly in event-driven code:

```typescript
if (change.action === 'add') {
	handleAdd(change);
} else if (change.action === 'update') {
	handleUpdate(change);
} else if (change.action === 'delete') {
	handleDelete(change);
}
```

Every branch tests `change.action` against a string. The variable never changes. The comparisons are always `===`. This is exactly what `switch` was built for.

## The Fix

```typescript
switch (change.action) {
	case 'add':
		handleAdd(change);
		break;
	case 'update':
		handleUpdate(change);
		break;
	case 'delete':
		handleDelete(change);
		break;
}
```

Three things improved: the variable under test appears once, each case reads as a label rather than a boolean expression, and adding a new case is one line instead of a new `else if` clause.

## Fall-Through for Shared Logic

The real win comes when cases share behavior. With if/else you get this:

```typescript
if (change.action === 'add' || change.action === 'update') {
	applyChange(change);
} else if (change.action === 'delete') {
	removeChange(change);
}
```

With switch, the grouping is structural:

```typescript
switch (change.action) {
	case 'add':
	case 'update':
		applyChange(change);
		break;
	case 'delete':
		removeChange(change);
		break;
}
```

No boolean operators. No repeating the variable name. The two cases literally fall into each other.

## Block Scoping

When a case needs local variables, wrap it in braces:

```typescript
switch (type) {
	case 'json': {
		const json = JSON.parse(content);
		json.version = newVersion;
		await writeFile(path, JSON.stringify(json, null, '\t'));
		break;
	}
	case 'toml': {
		const updated = content.replace(versionRegex, `version = "${newVersion}"`);
		await writeFile(path, updated);
		break;
	}
}
```

Without the braces, `const` declarations leak across cases. The braces fix that.

## When If/Else is Still Better

Early returns for type narrowing don't benefit from switch. When each branch returns and the point is to narrow for subsequent code, sequential ifs are cleaner:

```typescript
const result = table.get(id);
if (result.status === 'not_found') return { status: 'not_found', id };
if (result.status === 'invalid') return { status: 'invalid', errors: result.errors };
// result is now narrowed to 'valid'
const row = result.row;
```

This reads top-to-bottom: bail early, then work with the happy path. Wrapping it in a switch would add indentation without adding clarity.

| Pattern | Use |
| --- | --- |
| Same variable compared to 2+ constants | `switch` |
| Early return guards narrowing a type | `if` |
| Mixed conditions (`x > 5 && y === 'foo'`) | `if` |

The rule is simple: if every branch is `variable === constant`, reach for `switch`.
