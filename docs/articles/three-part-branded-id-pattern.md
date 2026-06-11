# Three Parts, One ID, and a Fourth When You Need Both Directions

Every branded ID in the workspace codebase follows the same canonical shape: a validator that lives in the value space, a type derived from it via `typeof X.infer`, and zero, one, or two helpers sized to where the value comes from. Most workspace IDs end up with three exports; the ones that flow in from both directions (minted by the app AND received from URL params or DB rows) end up with four.

```typescript
// Validator first; type derived. One PascalCase name in both namespaces.
export const SavedTabId = type('string').as<Id & Brand<'SavedTabId'>>();
export type SavedTabId = typeof SavedTabId.infer;

// generate* for IDs minted fresh by this code.
export const generateSavedTabId = (): SavedTabId => generateId<SavedTabId>();

// asXxx for trusted strings flowing in from another typed source. Optional.
export const asSavedTabId = (value: string): SavedTabId => value as SavedTabId;
```

`SavedTabId` is the arktype validator in `id: SavedTabId` inside a schema and the inferred branded type in a parameter annotation. There is no `SavedTabIdSchema` alias, no separate constructor function; one name covers both namespaces because TypeScript keeps them separate.

## Validator-first declaration

Declaring the validator first and deriving the type via `typeof SavedTabId.infer` makes the validator the single source of truth. If the brand changes or the underlying primitive switches from `Id` to plain `string`, you change one place and the type follows. Declaring the type first and re-passing it into `type('string').as<SavedTabId>()` works too, but it encodes the same shape twice. Prefer validator-first for new code.

## Extend the base Id type to simplify the factory generic

The brand intersects with `Id` (which is `string & Brand<'Id'>`) rather than bare `string`. That lets the factory use `generateId<SavedTabId>()` directly. The generic is constrained to `T extends string`, so any brand on top of `Id` (which extends `string`) flows through without a cast.

```typescript
// Good: factory uses the generic; no `as` in the body.
export const generateSavedTabId = (): SavedTabId => generateId<SavedTabId>();

// Older form (still in some files): cast inside the factory.
export const generateSavedTabId = (): SavedTabId => generateId() as SavedTabId;
```

Both compile. The generic form is preferred because the only intentional `as <Brand>` per ID is then the `asXxx` helper, and the factory's signature carries the brand on its return type rather than in a cast.

## Use `.as<>()` for zero-cost type assertions, not `.pipe()`

`.pipe()` runs a function at runtime; `.as<>()` is a pure compile-time assertion that arktype reads directly off the type argument. For brand application the two are functionally equivalent, but `.pipe()` is three lines of ceremony for nothing.

```typescript
// Good: zero-cost, concise.
export const SavedTabId = type('string').as<Id & Brand<'SavedTabId'>>();

// Bad: pipe ceremony.
export const SavedTabId = type('string').pipe((s): SavedTabId => s as SavedTabId);
```

## Pick the helpers by ID origin

| Origin of the value                         | Helpers to add                                                  |
| ------------------------------------------- | --------------------------------------------------------------- |
| Minted fresh by this code                   | `generateXxx()`                                                 |
| Received as a typed `string` (auth, URL, DB column, page param) | `asXxx(value: string)` syntactic-sugar helper       |
| Both of the above                           | Both helpers, declared next to the validator                    |
| Received as `unknown` at a network boundary | None: use the validator's `.assert(unknown)` or schema-level validation |
| Set from an external source, never minted   | `asXxx` helper                                                  |

The repo's IDs split as follows:

- **Validator + type + `generate*` only** (workspace-internal): `SavedTabId`, `BookmarkId`, `FileId`'s `RowId` and `ColumnId` siblings, etc. They're minted by the app and never received from outside.
- **Validator + type + `asXxx` only** (purely external): `UserId` from `@epicenter/auth` and `OwnerId` from `@epicenter/identity`. The user id is issued by Better Auth and arrives as a typed string; the owner id is the partition key derived from it. Nothing in the codebase mints them.
- **Validator + type + both helpers** (minted AND received): `FileId`, `ConversationId`, `ChatMessageId`, `EntryId`, `NoteId`, `FolderId`, `DeviceId`. The app generates them with `generate*` and also brands them with `as*` when reading them back from URL params, DB rows, page params, or external strings.

For the third row, the two helpers do unrelated jobs and both earn their keep:

```typescript
// generate* mints a fresh value, no caller input needed.
const newFile: FileId = generateFileId();

// as* brands an externally-provided typed string.
const fromUrl: FileId = asFileId(page.url.searchParams.get('file')!);
```

## Distinguish `generate*` from `create*`

`generate*` means a new ID minted from scratch: `generateId()`, `generateGuid()`, or `nanoid()` under the hood. `create*` means assembling an ID from existing inputs:

```typescript
export const generateSavedTabId = (): SavedTabId => generateId<SavedTabId>();
export const createTabCompositeId = (deviceId: DeviceId, tabId: TabId): TabCompositeId =>
	`${deviceId}:${tabId}` as TabCompositeId;
```

Both are factory functions. The prefix tells the reader whether the function fabricates randomness or composes existing identity.

## `asXxx` is the only place `as Xxx` should appear in the codebase

The `asXxx` helper exists to centralize the typed cast. Once it exists, raw `value as Xxx` casts elsewhere are a smell. The helper's `value: string` parameter rejects accidental `unknown` widenings and any code that wants to bypass it has to spell out a real reason.

```typescript
// Good: helper centralizes the cast, rejects unknown widening.
const fileId = asFileId(searchParams.get('file') ?? '');

// Bad: raw cast scattered through consumer code; silently swallows undefined.
const fileId = searchParams.get('file') as FileId;
```

Inside the helper itself the `as` is intentional and unavoidable; that single body is the sanctioned spot. Generators are the other sanctioned spot, and the modern generic form (`generateId<Xxx>()`) removes the cast even there.

## Why this matters

The branded-ID pattern catches type confusion that structural typing misses. A `FileId` is not a `ConversationId` even though both are strings at runtime. The validator makes the brand survive arktype schema composition; the type makes the brand visible to function signatures and hover docs; `generate*` keeps random-ID minting honest; and `asXxx` keeps the cast that turns a string into a brand pinned to one searchable spot in the codebase.

You can find the canonical multi-ID workspace in `apps/tab-manager/src/lib/workspace/definition.ts`, the purely-external IDs in `packages/auth/src/ids.ts`, and the both-directions case in `apps/opensidian/workspace.ts` and `packages/filesystem/src/ids.ts`.
