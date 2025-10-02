# Why `bind:value` with Getter/Setter Tuples is Superior to `oninput` for Number Inputs

When working with HTML range inputs (or any input that needs type conversion) in Svelte 5, you have two main patterns for handling values. This article explains why the `bind:value` with getter/setter tuple pattern is preferable.

## The Two Patterns

### Pattern 1: `oninput` Handler (Verbose)

```svelte
<input
  type="range"
  value={value}
  oninput={(e) => {
    value = Number(e.currentTarget.value);
  }}
/>
```

### Pattern 2: `bind:value` with Getter/Setter (Preferred)

```svelte
<input
  type="range"
  bind:value={
    () => String(value),
    (v) => {
      value = Number(v);
    }
  }
/>
```

## Why `bind:value` is Better

### 1. More Succinct and Declarative

The `bind:value` pattern is cleaner and more declarative. You directly express the transformation in both directions without dealing with event objects.

**Compare:**
```svelte
<!-- Verbose: Extract value from event object -->
oninput={(e) => {
  value = Number(e.currentTarget.value);
}}

<!-- Succinct: Direct value transformation -->
bind:value={
  () => String(value),
  (v) => { value = Number(v); }
}
```

### 2. No Event Object Destructuring

With `bind:value`, the setter function receives the actual value directly as a typed parameter. You don't need to destructure the event or access `e.currentTarget.value`.

**Compare:**
```svelte
<!-- Need to destructure event object -->
oninput={(e) => {
  value = Number(e.currentTarget.value);
}}

<!-- Direct value parameter -->
bind:value={
  () => String(value),
  (v) => { value = Number(v); }  // v is already the value!
}
```

### 3. Properly Typed

In the `bind:value` pattern, the parameter `v` in the setter is properly typed as `string` (since HTML inputs always return strings). This makes the type conversion explicit and intentional.

```svelte
bind:value={
  () => String(value),        // getter: number → string
  (v) => {                    // setter: v is typed as string
    value = Number(v);        // explicit conversion: string → number
  }
}
```

### 4. Better for Getter/Setter Patterns

When you're working with stores or complex state management, the `bind:value` pattern shines because both directions (read and write) are explicitly defined in one place:

```svelte
<input
  type="range"
  bind:value={
    () => Math.round(settings.value['volume'] * 100),
    (v) => settings.updateKey('volume', Number(v) / 100)
  }
/>
```

With `oninput`, you'd need to duplicate the transformation logic:

```svelte
<input
  type="range"
  value={Math.round(settings.value['volume'] * 100)}
  oninput={(e) => {
    settings.updateKey('volume', Number(e.currentTarget.value) / 100);
  }}
/>
```

## Why Type Conversion is Necessary

HTML `<input type="range">` elements always return string values, even though they represent numbers. This is a fundamental characteristic of the DOM API.

When you set the slider to 0, the input's value becomes the string `"0"`, not the number `0`. If you don't explicitly convert this to a number, you can run into issues:

1. **Type mismatches**: Your component expects `number`, but gets `string`
2. **Reactivity issues**: Svelte's reactivity system might not trigger when comparing `"0"` (string) vs `0` (number)
3. **Calculation errors**: Mathematical operations on strings can produce unexpected results

## The Complete Pattern

Here's the complete pattern for a reusable slider component:

```svelte
<script lang="ts">
  let {
    value = $bindable(),
    min = 0,
    max = 100,
    step = 1,
  }: {
    value: number;
    min?: number;
    max?: number;
    step?: number;
  } = $props();
</script>

<input
  type="range"
  {min}
  {max}
  {step}
  bind:value={
    () => String(value),    // Convert number to string for the input
    (v) => {
      value = Number(v);    // Convert string back to number for the prop
    }
  }
/>
```

## Real-World Example

In Whispering's sound settings, volume sliders need to work with decimal values (0-1) but display as percentages (0-100):

```svelte
<LabeledSlider
  bind:value={
    () => Math.round(settings.value['sound.volume.manual-start'] * 100),
    (v) => settings.updateKey('sound.volume.manual-start', Number(v) / 100)
  }
  min={0}
  max={100}
  step={5}
/>
```

This pattern:
- Reads the decimal value and converts to percentage (0.5 → 50)
- Takes the percentage from the slider and converts back to decimal (50 → 0.5)
- Explicitly converts the string from the input to a number
- Updates the store with the correct decimal value

## The Bug This Fixes

Without explicit number conversion, a bug occurred where the volume slider would get stuck at 0. Here's what was happening:

1. User drags slider to 0
2. Input returns `"0"` (string)
3. Setter stores `"0"` or coerces to `0` inconsistently
4. Getter returns `0` (number)
5. Svelte compares `"0"` !== `0` and reactivity breaks

By explicitly converting to `Number(v)` in the setter, we ensure the stored value is always a number, fixing the reactivity issue.

## Conclusion

Use `bind:value` with getter/setter tuples for inputs that need type conversion. It's:
- More declarative and succinct
- Better typed
- Eliminates event object boilerplate
- Prevents subtle reactivity bugs
- Makes transformations explicit in both directions

The pattern is especially powerful when working with stores, complex state, or when you need to transform values (like percentage ↔ decimal).
