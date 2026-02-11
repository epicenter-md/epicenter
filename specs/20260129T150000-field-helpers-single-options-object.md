# Refactor: Field Helpers to Single Options Object Pattern

**Status**: Complete
**Created**: 2026-01-29

## Decision Summary

Convert all field helper functions from the current ID-first positional pattern to a **single options object** pattern where ALL properties (including `id`) are in one destructured object.

**Key decisions:**

1. **Single argument pattern** - Every field helper takes one options object
2. **`id` moves into the object** - No more positional `id` argument
3. **Consistent required/optional** - Required props are required in the object, optional props have defaults
4. **`name` defaults to `id`** - If `name` is not provided, it defaults to the field's `id` value
5. **No more signature variations** - `select()` and `text()` have the same shape (just different required keys)
6. **JSDoc on all options** - Every option property has JSDoc for IDE hover documentation

## Rationale

### Why Single Options Object?

Research into API design best practices revealed:

1. **3+ positional args is the hard limit** - ESLint and style guides recommend options objects for 3+ parameters
2. **Self-documenting at call site** - `{ id: 'title', nullable: true }` is clearer than positional args
3. **Required props in options is acceptable** - When you have 1-2 required + many optional, mixing in one object is fine
4. **Future-proof** - Easy to add new properties without changing signatures
5. **Consistent mental model** - Every field helper has the same shape

### Comparison with Schema Libraries

| Library      | Pattern               | Example                                         |
| ------------ | --------------------- | ----------------------------------------------- | -------- |
| **Zod**      | Method + chaining     | `z.enum(['a', 'b']).optional()`                 |
| **ArkType**  | Single object         | `type({ status: "'a'                            | 'b'" })` |
| **TypeBox**  | Positional + options  | `Type.Enum(['a', 'b'], { description })`        |
| **Drizzle**  | Positional + chaining | `integer('count').notNull()`                    |
| **Proposed** | Single object         | `select({ id: 'status', options: ['a', 'b'] })` |

Our approach aligns most closely with ArkType's philosophy: everything in one place, self-documenting.

## Current vs Proposed

### Simple Field (text)

**Current:**

```typescript
text('title');
text('title', { nullable: true });
text('title', { name: 'Title', nullable: true, default: 'Untitled' });
```

**Proposed:**

```typescript
text({ id: 'title' });
text({ id: 'title', nullable: true });
text({ id: 'title', name: 'Title', nullable: true, default: 'Untitled' });
```

### Constrained Field (select)

**Current:**

```typescript
select('status', { options: ['draft', 'published'] });
select('status', {
	options: ['draft', 'published'],
	name: 'Status',
	default: 'draft',
});
```

**Proposed:**

```typescript
select({ id: 'status', options: ['draft', 'published'] });
select({
	id: 'status',
	options: ['draft', 'published'],
	name: 'Status',
	default: 'draft',
});
```

### Table Definition

**Current:**

```typescript
table('posts', {
	name: 'Posts',
	fields: [
		id(),
		text('title'),
		select('status', { options: ['draft', 'published'] }),
	],
});
```

**Proposed:**

```typescript
table({
	id: 'posts',
	name: 'Posts',
	fields: [
		id(),
		text({ id: 'title' }),
		select({ id: 'status', options: ['draft', 'published'] }),
	],
});
```

### Full Workspace Definition

**Current:**

```typescript
defineWorkspace({
	tables: [
		table('posts', {
			name: 'Posts',
			icon: '📝',
			fields: [
				id(),
				text('title', { name: 'Title' }),
				text('content', { name: 'Content', nullable: true }),
				select('status', {
					name: 'Status',
					options: ['draft', 'published'],
					default: 'draft',
				}),
				boolean('published', { default: false }),
				integer('views', { default: 0 }),
				date('createdAt'),
			],
		}),
	],
	kv: [
		select('theme', {
			name: 'Theme',
			options: ['light', 'dark'],
			default: 'light',
		}),
		integer('fontSize', { name: 'Font Size', default: 14 }),
	],
});
```

**Proposed:**

```typescript
defineWorkspace({
	tables: [
		table({
			id: 'posts',
			name: 'Posts',
			icon: '📝',
			fields: [
				id(),
				text({ id: 'title', name: 'Title' }),
				text({ id: 'content', name: 'Content', nullable: true }),
				select({
					id: 'status',
					name: 'Status',
					options: ['draft', 'published'],
					default: 'draft',
				}),
				boolean({ id: 'published', default: false }),
				integer({ id: 'views', default: 0 }),
				date({ id: 'createdAt' }),
			],
		}),
	],
	kv: [
		select({
			id: 'theme',
			name: 'Theme',
			options: ['light', 'dark'],
			default: 'light',
		}),
		integer({ id: 'fontSize', name: 'Font Size', default: 14 }),
	],
});
```

## Required vs Optional Properties

### Field Helpers

| Factory      | Required        | Optional (with defaults)                                                         |
| ------------ | --------------- | -------------------------------------------------------------------------------- |
| `id()`       | (none)          | `id='id'`, `name=id`, `description=''`, `icon=null`                              |
| `text()`     | `id`            | `nullable=false`, `default`, `name=id`, `description=''`, `icon=null`            |
| `richtext()` | `id`            | `name=id`, `description=''`, `icon=null`                                         |
| `integer()`  | `id`            | `nullable=false`, `default`, `name=id`, `description=''`, `icon=null`            |
| `real()`     | `id`            | `nullable=false`, `default`, `name=id`, `description=''`, `icon=null`            |
| `boolean()`  | `id`            | `nullable=false`, `default`, `name=id`, `description=''`, `icon=null`            |
| `date()`     | `id`            | `nullable=false`, `default`, `name=id`, `description=''`, `icon=null`            |
| `select()`   | `id`, `options` | `nullable=false`, `default`, `name=id`, `description=''`, `icon=null`            |
| `tags()`     | `id`            | `options`, `nullable=false`, `default`, `name=id`, `description=''`, `icon=null` |
| `json()`     | `id`, `schema`  | `nullable=false`, `default`, `name=id`, `description=''`, `icon=null`            |

**Note:** `name` defaults to `id` - e.g., `text({ id: 'firstName' })` produces `{ id: 'firstName', name: 'firstName', ... }`.

### Table and KV Helpers

| Factory     | Required               | Optional (with defaults)      |
| ----------- | ---------------------- | ----------------------------- |
| `table()`   | `id`, `name`, `fields` | `description=''`, `icon=null` |
| `setting()` | `name`, `field`        | `description=''`, `icon=null` |

**Note:** `setting()` is deprecated; KV now uses field helpers directly.

**Note:** For `table()`, `name` is required (not defaulted from `id`) because table names are always user-facing and should be human-readable (e.g., "Blog Posts" not "blogPosts").

## Type System Changes

### New Factory Signatures

````typescript
// ════════════════════════════════════════════════════════════════════════════
// SIMPLE FIELDS (id required, rest optional)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Creates an ID field (primary key).
 * Can be called with no args (defaults to id='id') or with options.
 *
 * @example
 * ```typescript
 * id()                        // → { id: 'id', name: 'id', type: 'id', ... }
 * id({ id: 'postId' })        // → { id: 'postId', name: 'postId', type: 'id', ... }
 * id({ id: 'postId', name: 'Post ID' })
 * ```
 */
export function id(): IdField & { id: 'id' };
export function id<const K extends string>(opts: {
	/** Unique identifier for this field. */
	id: K;
	/** Display name. Defaults to id. */
	name?: string;
	/** Description for tooltips/docs. Defaults to empty string. */
	description?: string;
	/** Icon for UI. Defaults to null. */
	icon?: Icon | null;
}): IdField & { id: K };

/**
 * Creates a text (string) field.
 *
 * @example
 * ```typescript
 * text({ id: 'title' })
 * text({ id: 'title', name: 'Post Title' })
 * text({ id: 'subtitle', nullable: true })
 * text({ id: 'status', default: 'active' })
 * ```
 */
export function text<const K extends string>(opts: {
	/** Unique identifier for this field within its table. */
	id: K;
	/** Whether null values are allowed. Defaults to false. */
	nullable?: false;
	/** Default value for new rows. */
	default?: string;
	/** Display name. Defaults to id. */
	name?: string;
	/** Description for tooltips/docs. Defaults to empty string. */
	description?: string;
	/** Icon for UI. Defaults to null. */
	icon?: Icon | null;
}): TextField<false> & { id: K };

export function text<const K extends string>(opts: {
	id: K;
	nullable: true;
	default?: string;
	name?: string;
	description?: string;
	icon?: Icon | null;
}): TextField<true> & { id: K };

// integer(), real(), boolean(), date() follow the same pattern

// ════════════════════════════════════════════════════════════════════════════
// CONSTRAINED FIELDS (id + semantic config required)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Creates a select field (single choice from predefined options).
 *
 * @example
 * ```typescript
 * select({ id: 'status', options: ['draft', 'published'] })
 * select({ id: 'status', options: ['draft', 'published'], default: 'draft' })
 * select({ id: 'priority', options: ['low', 'medium', 'high'], name: 'Priority Level' })
 * ```
 */
export function select<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>(opts: {
	/** Unique identifier for this field within its table. */
	id: K;
	/** Allowed values for this field. Must have at least one option. */
	options: TOptions;
	/** Whether null values are allowed. Defaults to false. */
	nullable?: false;
	/** Default value for new rows. Must be one of the options. */
	default?: TOptions[number];
	/** Display name. Defaults to id. */
	name?: string;
	/** Description for tooltips/docs. Defaults to empty string. */
	description?: string;
	/** Icon for UI. Defaults to null. */
	icon?: Icon | null;
}): SelectField<TOptions, false> & { id: K };

export function select<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>(opts: {
	id: K;
	options: TOptions;
	nullable: true;
	default?: TOptions[number];
	name?: string;
	description?: string;
	icon?: Icon | null;
}): SelectField<TOptions, true> & { id: K };

/**
 * Creates a JSON field with TypeBox schema validation.
 *
 * @example
 * ```typescript
 * import { Type } from 'typebox';
 *
 * json({ id: 'settings', schema: Type.Object({ theme: Type.String() }) })
 * json({ id: 'metadata', schema: MySchema, nullable: true })
 * ```
 */
export function json<const K extends string, const T extends TSchema>(opts: {
	/** Unique identifier for this field within its table. */
	id: K;
	/** TypeBox schema for validation. */
	schema: T;
	/** Whether null values are allowed. Defaults to false. */
	nullable?: false;
	/** Default value for new rows. Must conform to schema. */
	default?: Static<T>;
	/** Display name. Defaults to id. */
	name?: string;
	/** Description for tooltips/docs. Defaults to empty string. */
	description?: string;
	/** Icon for UI. Defaults to null. */
	icon?: Icon | null;
}): JsonField<T, false> & { id: K };

// ════════════════════════════════════════════════════════════════════════════
// TABLE (id, name, fields required)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Creates a table definition.
 *
 * Unlike field helpers, `name` is required for tables because table names
 * are always user-facing and should be human-readable.
 *
 * @example
 * ```typescript
 * table({
 *   id: 'posts',
 *   name: 'Blog Posts',
 *   fields: [id(), text({ id: 'title' }), boolean({ id: 'published' })],
 * })
 *
 * table({
 *   id: 'posts',
 *   name: 'Blog Posts',
 *   description: 'All blog posts and articles',
 *   icon: '📝',
 *   fields: [...],
 * })
 * ```
 */
export function table<const TFields extends readonly Field[]>(opts: {
	/** Unique identifier for this table. Used as storage key. */
	id: string;
	/** Display name shown in UI. Required for tables. */
	name: string;
	/** Field definitions for this table. */
	fields: TFields;
	/** Description for tooltips/docs. Defaults to empty string. */
	description?: string;
	/** Icon for UI. Accepts tagged or plain emoji. Defaults to null. */
	icon?: string | Icon | null;
}): TableDefinition<TFields>;
````

### Implementation Pattern

```typescript
export function text<const K extends string>({
	id,
	nullable = false,
	default: defaultValue,
	name = id, // ← Defaults to id if not provided
	description = '',
	icon = null,
}: {
	/** Unique identifier for this field within its table. */
	id: K;
	/** Whether the field can store null values. Defaults to false. */
	nullable?: boolean;
	/** Default value for new rows. */
	default?: string;
	/** Display name shown in UI. Defaults to id if not provided. */
	name?: string;
	/** Description shown in tooltips and documentation. Defaults to empty string. */
	description?: string;
	/** Icon for the field. Accepts 'emoji:X', 'lucide:X', or plain emoji. Defaults to null. */
	icon?: Icon | null;
}): TextField<boolean> & { id: K } {
	return {
		id,
		type: 'text',
		name,
		description,
		icon: normalizeIcon(icon),
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && { default: defaultValue }),
	};
}
```

**Result of `name` defaulting to `id`:**

```typescript
text({ id: 'firstName' });
// → { id: 'firstName', name: 'firstName', type: 'text', description: '', icon: null }

text({ id: 'firstName', name: 'First Name' });
// → { id: 'firstName', name: 'First Name', type: 'text', description: '', icon: null }
```

### Shared Options Type

````typescript
/**
 * Common options for all field helpers.
 * All are optional with sensible defaults.
 */
type FieldMetadataOptions = {
	/**
	 * Display name shown in UI.
	 * Defaults to the field's `id` if not provided.
	 *
	 * @example
	 * ```typescript
	 * text({ id: 'firstName' })              // name = 'firstName'
	 * text({ id: 'firstName', name: 'First Name' }) // name = 'First Name'
	 * ```
	 */
	name?: string;

	/**
	 * Description shown in tooltips and documentation.
	 * Defaults to empty string.
	 *
	 * @example
	 * ```typescript
	 * text({ id: 'email', description: 'Primary contact email address' })
	 * ```
	 */
	description?: string;

	/**
	 * Icon for the field in UI.
	 * Accepts tagged format ('emoji:📝', 'lucide:file-text') or plain emoji ('📝').
	 * Plain emoji is auto-converted to tagged format.
	 * Defaults to null.
	 *
	 * @example
	 * ```typescript
	 * text({ id: 'title', icon: '📝' })           // → 'emoji:📝'
	 * text({ id: 'title', icon: 'lucide:type' })  // → 'lucide:type'
	 * ```
	 */
	icon?: Icon | string | null;
};

/**
 * Options for nullable fields.
 */
type NullableOptions<T> = {
	/**
	 * Whether the field can store null values.
	 * Defaults to false (NOT NULL).
	 *
	 * @example
	 * ```typescript
	 * text({ id: 'title' })                    // NOT NULL
	 * text({ id: 'subtitle', nullable: true }) // NULL allowed
	 * ```
	 */
	nullable?: boolean;

	/**
	 * Default value when creating new rows.
	 * If not provided, the field has no default (must be explicitly set on insert,
	 * unless nullable).
	 *
	 * @example
	 * ```typescript
	 * integer({ id: 'views', default: 0 })
	 * boolean({ id: 'published', default: false })
	 * select({ id: 'status', options: ['draft', 'published'], default: 'draft' })
	 * ```
	 */
	default?: T;
};
````

## Files to Modify

### Phase 1: Update Factory Signatures

| File                              | Changes                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `core/schema/fields/factories.ts` | Rewrite all field factories to single options object pattern |
| `core/schema/fields/types.ts`     | Update `FieldOptions` type if needed                         |

### Phase 2: Update Consumers

| File                           | Changes                  |
| ------------------------------ | ------------------------ |
| All test files using factories | Update call sites        |
| `static/define-workspace.ts`   | Update examples in JSDoc |
| All JSDoc examples             | Update to new pattern    |

### Phase 3: Update Documentation

| File                           | Changes                  |
| ------------------------------ | ------------------------ |
| `packages/epicenter/README.md` | Update all examples      |
| `docs/articles/*.md`           | Update relevant articles |
| `specs/*.md`                   | Update examples in specs |

## Migration Patterns

### Automated Migration (AST-based)

This refactor is amenable to automated migration using ast-grep:

```yaml
# ast-grep rule: text(id) → text({ id })
id: text-positional-to-options
language: typescript
rule:
  pattern: text($ID)
  not:
    pattern: text({ $$$_ })
fix: text({ id: $ID })

# ast-grep rule: text(id, opts) → text({ id, ...opts })
id: text-positional-opts-to-options
language: typescript
rule:
  pattern: text($ID, { $$$OPTS })
fix: text({ id: $ID, $$$OPTS })

# Similar rules for integer, boolean, real, date, richtext, tags, select, json
```

### Manual Migration Examples

```typescript
// BEFORE → AFTER

// Simple field
text('title')                              → text({ id: 'title' })
text('title', { nullable: true })          → text({ id: 'title', nullable: true })

// Field with metadata
text('title', { name: 'Title' })           → text({ id: 'title', name: 'Title' })

// Select (no change in structure, just id moves)
select('status', { options: ['a', 'b'] })  → select({ id: 'status', options: ['a', 'b'] })

// Table
table('posts', { name: 'Posts', fields })  → table({ id: 'posts', name: 'Posts', fields })
```

## Implementation Order

1. **Update type definitions** - Add new overloads or replace signatures in `types.ts`
2. **Update `id()` factory** - Special case (no required args)
3. **Update simple field factories** - `text`, `integer`, `real`, `boolean`, `date`, `richtext`
4. **Update constrained field factories** - `select`, `json`, `tags`
5. **Update `table()` factory** - Move `id` into options
6. **Update `setting()` factory** - Already deprecated, but update for consistency
7. **Run ast-grep migration** - Automated updates across codebase
8. **Manual cleanup** - Fix any edge cases
9. **Update all tests** - Verify passing
10. **Update documentation** - README, JSDoc, articles

## JSDoc Documentation Strategy

Every option property must have JSDoc for IDE hover documentation. This improves developer experience significantly.

### Required JSDoc Elements

1. **Brief description** - What the property does
2. **Default value** - What happens if not provided
3. **@example block** - For non-obvious properties

### Example: Well-Documented Option

````typescript
{
	/**
	 * Display name shown in UI.
	 * Defaults to the field's `id` if not provided.
	 *
	 * @example
	 * ```typescript
	 * text({ id: 'firstName' })              // name = 'firstName'
	 * text({ id: 'firstName', name: 'First Name' }) // name = 'First Name'
	 * ```
	 */
	name?: string;
}
````

### IDE Experience

When a developer hovers over `name` in their editor:

```
(property) name?: string

Display name shown in UI.
Defaults to the field's `id` if not provided.

@example
text({ id: 'firstName' })              // name = 'firstName'
text({ id: 'firstName', name: 'First Name' }) // name = 'First Name'
```

This self-documenting approach reduces the need to consult external docs.

## Validation Checklist

- [ ] All factories accept single options object
- [ ] TypeScript compiles without errors
- [ ] Type inference works (literal types for `id`, `options`)
- [ ] `name` defaults to `id` when not provided
- [ ] All tests pass
- [ ] Every option property has JSDoc with description and default
- [ ] JSDoc examples updated
- [ ] README examples updated

## Risks and Mitigations

| Risk                                   | Mitigation                                       |
| -------------------------------------- | ------------------------------------------------ |
| Breaking change for external consumers | No external consumers yet; internal refactor     |
| Verbose for simple cases               | Acceptable tradeoff for consistency              |
| `id` less prominent                    | `id` is always first key in object by convention |
| Type inference regression              | Test with complex select/tags options            |

## Alternatives Considered

### Alternative 1: Keep Current (ID positional)

- **Rejected**: Inconsistent signatures between fields (select requires opts, text doesn't)

### Alternative 2: Positional Semantic Args

```typescript
select('status', ['a', 'b']);
select('status', ['a', 'b'], { name: 'Status' });
```

- **Rejected**: Gets awkward with 3 positional args; what if a field needs 2 semantic args?

### Alternative 3: Builder Pattern

```typescript
select('status').options(['a', 'b']).name('Status').build();
```

- **Rejected**: More verbose, loses `const` type inference, implementation complexity

### Alternative 4: Name Required (No Default)

```typescript
text({ id: 'title', name: 'Title' }); // name required, no default
```

- **Rejected**: Too verbose for prototyping. Instead, `name` defaults to `id` which provides a sensible fallback while allowing explicit override

## Future Considerations

### Strict Mode for Production Apps

For apps where every field MUST have a human-readable name (not just the id):

```typescript
// Could add a strict mode or lint rule that warns when name === id
// This would catch cases like:
text({ id: 'firstName' }); // Warning: name defaults to 'firstName', consider setting explicit name

// vs
text({ id: 'firstName', name: 'First Name' }); // OK
```

### Shorthand for Common Patterns

If verbosity becomes a pain point:

```typescript
// Could add shortcuts
t('title'); // alias for text({ id: 'title' })
s('status', ['a', 'b']); // alias for select({ id: 'status', options: ['a', 'b'] })
```

But start simple; add sugar only if needed.

### Runtime Validation (Deferred)

Could add validation for common mistakes:

- Empty `options` array in select
- Duplicate options in select/tags
- Invalid `default` value (not in options)
- Duplicate field ids in table

Deferred for now; TypeScript catches most issues at compile time.

## Summary

The single options object pattern provides:

1. **Consistency** - Every field helper has the same shape
2. **Self-documenting** - `{ id: 'title', nullable: true }` is clear at call site
3. **Smart defaults** - `name` defaults to `id`, reducing boilerplate while allowing override
4. **IDE-friendly** - JSDoc on every property enables rich hover documentation
5. **Future-proof** - Easy to add new properties without breaking signatures
6. **Type-safe** - Required props are enforced by TypeScript
7. **Familiar** - Aligns with common JS/TS patterns (React props, config objects)

The tradeoff is slightly more verbosity for simple cases (`text({ id: 'title' })` vs `text('title')`), but the consistency, clarity, and IDE experience benefits outweigh this cost.

---

## Review

**Implementation Date**: 2026-01-29  
**Status**: Complete ✅

### Summary

Successfully migrated all field helper functions from the ID-first positional pattern to the single options object pattern across the entire `packages/epicenter` codebase.

### Changes Made

#### Phase 1: Factory Signatures (1 file)

- **`packages/epicenter/src/core/schema/fields/factories.ts`**: Completely rewrote all factory functions to accept single options objects with `id` as a required property. Added `name` defaulting to `id`.

#### Phase 2: Consumer Files (~25+ files)

**Test Files (12 files, ~500+ call sites)**:

- `create-tables.test.ts` - 62 table calls, 67 text calls, many others
- `create-tables.types.test.ts` - similar scope
- `create-tables.crdt-sync.test.ts` - similar scope
- `create-tables.offline-sync.test.ts` - 33 changes
- `definition-helper.test.ts` - 65 changes
- `kv-helper.test.ts` - 43 changes
- `to-arktype.test.ts` - 9 changes
- `to-typebox.test.ts` - 100 changes
- `create-cell-workspace.test.ts`
- `cell/converters/to-typebox.test.ts`
- `validated-table-store.test.ts`
- `schema-file.test.ts`

**Script Files (3 files, 23 changes)**:

- `scripts/email-minimal-simulation.ts`
- `scripts/email-storage-simulation.ts`
- `scripts/yjs-vs-sqlite-comparison.ts`

**JSDoc Examples in Source Files (13+ files)**:

- `workspace.ts` - 5 examples
- `node.ts` - 3 examples
- `create-tables.ts` - 1 example
- `table-helper.ts` - 1 example
- `workspace-doc.ts` - 1 example
- `kv-helper.ts` - 1 example
- `core.ts` - 1 example
- `server.ts` - 1 example
- `sqlite.ts` - 1 example
- `create-cell-workspace.ts` - 1 example
- `normalize.ts` - 2 examples
- `definition-helper.ts` - 1 example
- `types.ts` - 4 examples
- `to-arktype.ts` - 1 example
- `to-typebox.ts` - 1 example

### Verification

- ✅ **788 tests pass** (2055 expect() calls)
- ✅ **Zero LSP errors** across all modified files
- ✅ **No old-style calls remain** (verified via grep)
- ✅ **Type inference preserved** for literal types on `id` and `options`
- ✅ **All `as const` assertions preserved**
- ✅ **All existing options preserved** (nullable, default, name, etc.)

### Migration Approach

Used a combination of:

1. Manual rewrites for the factory file
2. 8 parallel sub-agents for consumer file migrations
3. AST-grep patterns for bulk replacements where applicable
4. Perl/sed one-liners for simple patterns
5. Manual edits for edge cases

### Notes

- **`packages/vault-core/`** was correctly excluded (uses Drizzle ORM's `text()` function)
- **`to-drizzle.ts`** imports were correctly preserved (uses custom sqlite builders, not our field helpers)
- The migration was atomic—no intermediate broken states committed
