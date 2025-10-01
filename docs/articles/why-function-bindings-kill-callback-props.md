# Why Function Bindings Make Callback Props Obsolete

I migrated 50+ components from `onValueChange` callbacks to Svelte 5's function bindings. The result: better type safety, simpler APIs, and zero type assertions.

Function bindings solve fundamental problems with the callback pattern. After seeing the benefits, I now use `bind:` everywhere instead of `onChange` props, and I recommend others to do the same.

## The Callback Problem: Type Assertions Everywhere

Here's what every React/Svelte developer has written a thousand times:

```svelte
<Select
  value={settings.transcriptionService}
  onValueChange={(value) => {
    // Why do I need this cast?
    settings.update('transcriptionService', value as TranscriptionService);
  }}
  options={TRANSCRIPTION_SERVICES}
/>
```

That `as TranscriptionService` isn't just annoying—it's a symptom of broken type flow. TypeScript knows `value` should be `TranscriptionService`, but the callback pattern destroys that information.

This happens because callbacks create type indirection:

```
TranscriptionService → Generic T → Callback Parameter → Any
```

By the time you're in the callback, TypeScript has lost the specific type and fallen back to the constraint or `any`. Hence the cast.

## Function Bindings: Direct Type Flow

Function bindings eliminate the indirection:

```svelte
<Select
  bind:value={
    () => settings.transcriptionService,
    (value) => settings.update('transcriptionService', value)
  }
  options={TRANSCRIPTION_SERVICES}
/>
```

No cast. TypeScript traces the type directly from getter to setter:

```
Getter Return Type ← Direct Flow → Setter Parameter Type
```

The getter `() => settings.transcriptionService` establishes the concrete type `TranscriptionService`. TypeScript automatically ensures the setter parameter matches exactly. No information loss, no assertions.

## Real-World Impact: Before and After

### OpenAI Model Selection

**Callback Pattern (broken types):**
```svelte
<LabeledSelect
  selected={config.openai.model}
  onSelectedChange={(model) => {
    // Required cast - type system failed us
    updateConfig({ openai: { model: model as OpenAiModel }});
  }}
  items={OPENAI_MODELS}
/>
```

**Function Binding (perfect types):**
```svelte
<LabeledSelect
  bind:selected={
    () => config.openai.model,
    (model) => updateConfig({ openai: { model }})
  }
  items={OPENAI_MODELS}
/>
```

The difference: `model` is automatically typed as `OpenAiModel` in the function binding. No cast, no runtime risk, no guessing.

### Complex Generics

**Callback Pattern (generic collapse):**
```svelte
<script generics="T extends { id: string; metadata: Record<string, any> }">
  let {
    selectedItem,
    onSelectionChange,
    items
  }: {
    selectedItem: T | null;
    onSelectionChange: (item: T) => void;
    items: T[];
  } = $props();
</script>

<DataTable
  selectedItem={selected}
  onSelectionChange={(item) => {
    // TypeScript lost the specific T - need manual cast
    handleSelection(item as T);
  }}
/>
```

**Function Binding (generic preservation):**
```svelte
<script generics="T extends { id: string; metadata: Record<string, any> }">
  let {
    selectedItem = $bindable(),
    items
  }: {
    selectedItem: T | null;
    items: T[];
  } = $props();
</script>

<DataTable
  bind:selectedItem={
    () => selected,
    (item) => handleSelection(item) // item is correctly typed as T
  }
/>
```

The function binding maintains the full generic type `T`, not just the constraint.

## The Naming Nightmare: Remembering Callback Conventions

Beyond type issues, callbacks create a cognitive burden: **what's the callback named?**

Every component author picks their own convention:

```svelte
<!-- Is it onValueChange? -->
<Select value={model} onValueChange={setModel} />

<!-- Or onSelectedChange? -->
<ListBox selected={item} onSelectedChange={setItem} />

<!-- Maybe onCheckedChange? -->
<Checkbox checked={agreed} onCheckedChange={setAgreed} />

<!-- Could be onSelectionChange? -->
<DataGrid selection={rows} onSelectionChange={setRows} />

<!-- What about onChange? -->
<Input value={text} onChange={setText} />
```

As a developer, you constantly have to:
1. Check documentation to find the callback name
2. Remember if it's `onValueChange` vs `onSelectedChange` vs `onChange`
3. Remember the parameter name (`value`? `selected`? `checked`?)

With function bindings, it's always `bind:propName`:

```svelte
<!-- Always consistent -->
<Select bind:value={model} />
<ListBox bind:selected={item} />
<Checkbox bind:checked={agreed} />
<DataGrid bind:selection={rows} />
<Input bind:value={text} />
```

No documentation lookup. No mental mapping. Just `bind:` + the prop name.

## API Design: One Prop vs. Two

Callbacks also force dual-prop APIs:

```svelte
let {
  value,           // The current value
  onValueChange,   // How to update it
  placeholder,
  disabled
}: {
  value: T;
  onValueChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
} = $props();
```

Function bindings enable single-prop APIs:

```svelte
let {
  value = $bindable(), // Getter AND setter in one
  placeholder,
  disabled
}: {
  value: T;
  placeholder?: string;
  disabled?: boolean;
} = $props();
```

This isn't just fewer lines—it's conceptually cleaner. A "value" that can be read and written is one concept, not two.

## Component Implementation: Internal Benefits

Function bindings also improve your component's internal implementation:

**Callback Pattern (internal type casts):**
```svelte
<script generics="T">
  let {
    value,
    onValueChange
  }: {
    value: T;
    onValueChange: (value: T) => void;
  } = $props();
</script>

<BaseSelect
  value={value}
  onValueChange={(newValue) => {
    // Even internally, need to cast
    onValueChange(newValue as T);
  }}
/>
```

**Function Binding (perfect internal flow):**
```svelte
<script generics="T">
  let {
    value = $bindable()
  }: {
    value: T;
  } = $props();
</script>

<BaseSelect
  bind:value={() => value, (newValue) => (value = newValue)}
/>
```

The internal `newValue` parameter is automatically typed as `T`. No casts in your component implementation either.

## Performance: Fewer Object Allocations

Callbacks create function allocations on every render:

```svelte
{#each items as item}
  <ListItem
    selected={item.id === selectedId}
    onSelectedChange={() => setSelected(item.id)} <!-- New function every render -->
  />
{/each}
```

Function bindings can be more efficient:

```svelte
{#each items as item}
  <ListItem
    bind:selected={
      () => item.id === selectedId,
      (selected) => selected && setSelected(item.id)
    }
  />
{/each}
```

While both patterns can be optimized, function bindings naturally encourage more efficient patterns.

## IDE Experience: Better Everything

Function bindings give IDEs much richer information:

- **Autocomplete**: Perfect parameter types from getter context
- **Refactoring**: Rename operations trace through bindings correctly
- **Error highlighting**: Immediate feedback on type mismatches
- **Go-to-definition**: Jump from setter usage to getter definition

With callbacks, IDEs lose the connection between value and change handler.

## The Ecosystem Effect

If every component uses `$bindable()`, the entire ecosystem becomes more consistent:

```svelte
<!-- All use the same pattern -->
<Input bind:value={name} />
<Select bind:value={country} options={countries} />
<Checkbox bind:checked={agreed} />
<DatePicker bind:selected={birthday} />
```

Instead of:

```svelte
<!-- Inconsistent patterns -->
<Input bind:value={name} />
<Select value={country} onValueChange={setCountry} options={countries} />
<Checkbox checked={agreed} onCheckedChange={setAgreed} />
<DatePicker selected={birthday} onSelectedChange={setBirthday} />
```

Consistency reduces cognitive load and makes components more composable.

## Migration is Trivial

Converting from callbacks to function bindings is mechanical:

**1. Update component definition:**
```diff
let {
- value,
- onValueChange
+ value = $bindable()
} = $props();
```

**2. Update usage sites:**
```diff
<Component
- value={currentValue}
- onValueChange={(v) => setCurrentValue(v as MyType)}
+ bind:value={
+   () => currentValue,
+   (v) => setCurrentValue(v)
+ }
/>
```

**3. Delete type assertions:** They're no longer needed.

Each component can be migrated independently. The patterns can coexist during transition.

## The Verdict: Use $bindable() Everywhere

Function bindings aren't "another option"—they're the replacement for callback props. In every objective measure, they're superior:

- **Type safety**: Perfect generic handling without casts
- **API design**: Single-prop APIs instead of dual-prop
- **Performance**: Fewer allocations, better optimization potential  
- **Developer experience**: Better IDE support, cleaner refactoring
- **Consistency**: Uniform binding pattern across components

The only reason to use callback props is legacy compatibility. For new components, there's no technical justification for callbacks.

## Start Today

If you're building Svelte 5 components, make `$bindable()` your default. Don't think of it as "bidirectional binding"—think of it as "correct component API design."

The callback pattern was a workaround for limitations in earlier frameworks. Svelte 5 eliminates those limitations. There's no reason to keep using the workaround.

**Function bindings don't just improve your code—they prove that callback props were wrong all along.**