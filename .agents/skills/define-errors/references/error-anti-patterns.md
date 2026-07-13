# Error Anti-Patterns

## Anti-Pattern: Discriminated Union Inputs

**String literal unions inside error factory inputs are a code smell.** When a variant's input contains a field like `reason: 'a' | 'b' | 'c'` or `operation: 'x' | 'y' | 'z'`, you're creating a sub-discriminant that duplicates what `defineErrors` already provides at the top level.

### The Problem

```typescript
// BAD: Sub-discriminant forces double narrowing and dishonest types
const ShortcutError = defineErrors({
  InvalidAccelerator: (input: {
    reason: 'invalid_format' | 'no_key_code' | 'multiple_key_codes';
    accelerator?: string;  // Optional because some reasons don't use it
  }) => {
    const messages = {
      invalid_format: `Invalid format: '${input.accelerator}'`,
      no_key_code: 'No valid key code found',
      multiple_key_codes: 'Multiple key codes not allowed',
    };
    return { message: messages[input.reason], ...input };
  },
});
```

**Why this is bad:**
1. **Double narrowing**: Consumers must narrow on `error.name` then on `error.reason`
2. **Dishonest types**: `accelerator` is optional because some reasons don't need it, but the type doesn't express which ones do
3. **Obscured intent**: The `reason` field is doing the discriminant's job; that is what variant names are for

### The Fix: Split Into Separate Variants

```typescript
// GOOD: Each variant has exactly the fields it needs
const ShortcutError = defineErrors({
  InvalidFormat: ({ accelerator }: { accelerator: string }) => ({
    message: `Invalid accelerator format: '${accelerator}'`,
    accelerator,
  }),
  NoKeyCode: () => ({
    message: 'No valid key code found in pressed keys',
  }),
  MultipleKeyCodes: () => ({
    message: 'Multiple key codes not allowed in accelerator',
  }),
});
```

**Why this is better:**
- **Single narrowing**: `error.name === 'NoKeyCode'`, done
- **Honest types**: `InvalidFormat` requires `accelerator`, `NoKeyCode` takes nothing
- **Self-documenting**: Variant names describe the error, no lookup table needed

### When This Applies

Split whenever you see:
- `reason: 'a' | 'b' | 'c'` with a message lookup table
- `operation: 'x' | 'y' | 'z'` with different messages per operation
- `errorKind: ...` or `type: ...` acting as a sub-discriminant
- Optional fields that exist because "some variants" don't use them

The whole point of `defineErrors` is that each variant is a first-class citizen with its own name and shape. Collapsing them behind string unions saves a few lines of definition at the cost of weaker types and double-narrowing at every consumer.

### Exception: When It's Genuinely One Error

If the string literal truly is a *field* and not a sub-discriminant (for
example, the consumer does not switch on it), then it is fine:

```typescript
// OK: 'operation' is metadata for logging, not a sub-discriminant
const FsError = defineErrors({
  ReadFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
    message: `Failed to read '${path}': ${extractErrorMessage(cause)}`,
    path,
    cause,
  }),
  WriteFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
    message: `Failed to write '${path}': ${extractErrorMessage(cause)}`,
    path,
    cause,
  }),
});
```

## Anti-Pattern: Conditional Logic on Factory Inputs

**If a variant constructor uses if/switch on its own input fields to decide the
message or behavior, each branch should be its own variant.** This generalizes
the string literal union rule above: branching inside a constructor means
multiple errors are hiding in one variant.

### The Problem

```typescript
// BAD: Constructor branches on inputs, so multiple errors hide in one variant
const FormError = defineErrors({
  Validation: ({ field, value, receivedType }: {
    field?: string;     // Optional because not every branch uses it
    value?: string;     // Optional because not every branch uses it
    receivedType?: string; // Optional because not every branch uses it
  }) => ({
    message: (() => {
      if (field === 'email' && value) return `Invalid email address: '${value}'`;
      if (field === 'password' && value)
        return `Password too weak: must be at least 8 characters`;
      if (field === 'confirmPassword')
        return 'Passwords do not match';
      if (receivedType) return `Invalid form data: expected string, got ${receivedType}`;
      return 'Form submission failed';
    })(),
    field,
    value,
    receivedType,
  }),
});
```

**Symptoms:**
1. **Dishonest optionals**: Fields are optional because no single call site uses them all; the type lies about what each error actually carries
2. **Hidden branching**: Consumers must inspect fields beyond `name` to know the real error kind; `name === 'Validation'` tells you nothing
3. **Untypeable messages**: The message depends on runtime field combinations, so TypeScript can't narrow to a specific message shape

### The Fix: Flatten Each Branch Into Its Own Variant

```typescript
// GOOD: Each branch becomes its own variant with honest, required fields
const FormError = defineErrors({
  InvalidEmail: ({ value }: { value: string }) => ({
    message: `Invalid email address: '${value}'`,
    value,
  }),
  WeakPassword: () => ({
    message: 'Password too weak: must be at least 8 characters',
  }),
  PasswordMismatch: () => ({
    message: 'Passwords do not match',
  }),
  InvalidFormData: ({ receivedType }: { receivedType: string }) => ({
    message: `Invalid form data: expected string, got ${receivedType}`,
    receivedType,
  }),
  SubmissionFailed: () => ({
    message: 'Form submission failed',
  }),
});
```

**Why this is better:**
- **Honest types**: `InvalidEmail` requires `value`, while `WeakPassword` takes nothing; there are no dishonest optionals
- **Single narrowing**: `error.name === 'InvalidEmail'` tells you everything
- **Typeable messages**: Each variant has a deterministic message shape

### Rule of Thumb

If the constructor branches on its inputs to decide the message, each branch should be its own variant. The branching *is* the evidence that you have multiple distinct errors collapsed into one.

This applies to:
- **If/else chains** in message construction (including IIFEs)
- **Switch statements** on input fields
- **Ternary expressions** that pick between fundamentally different messages
- **Lookup tables** keyed on input fields (covered by the string literal union rule above)
