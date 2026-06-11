# Grep for `handle*` Functions

```bash
grep -rn 'function handle' --include='*.svelte' apps/
```

Run that in your project. If you get more than a handful of hits, you probably have an indirection problem.

`handle*` functions are almost always single-use wrappers. They sit between the event and the actual action, forcing you to jump from the template to the script block just to understand what happens when someone clicks a button. That's two reads where one would do.

**Before:**

```svelte
<script>
  function handleSave() {
    save(draft);
  }
</script>

<button onclick={handleSave}>Save</button>
```

**After:**

```svelte
<button onclick={() => save(draft)}>Save</button>
```

The inlined version is shorter, and you can read the whole thing without scrolling. The function name `handleSave` wasn't adding information. It was just restating what `save` already says.

This pattern shows up constantly in AI-generated code. AI assistants extract every event handler into a named function by default, even when the body is a single expression. It's not wrong, exactly, but it's not helpful either. The result is a script block full of one-liner functions that exist only to be called once.

## When to Keep It Extracted

Two cases where the extracted form is actually better:

**Used in multiple places.** If the same function is wired to both `onkeydown` and `onblur`, extract it. Duplicating the inline arrow function in two places is worse than one named function.

```svelte
<input onkeydown={handleCommit} onblur={handleCommit} />
```

**Has a JSDoc and a meaningful semantic name.** If the function does something non-obvious and you've written a doc comment explaining it, the name carries real information. Keep it. But if the JSDoc just says "handles the save button click," delete both the comment and the function.

## The Real Test

Ask: does the function name tell you something the inlined code doesn't? If the answer is no, inline it.

`handleClick`, `handleSubmit`, `handleChange`: these names describe the event, not the action. They're noise. `confirmAndDelete` or `syncToRemote` are different; those names carry intent that an arrow function can't.

This is related to the "Single-Use Functions: Inline or Document" rule in the Svelte skill guidelines. The principle is the same: if a function is used once and its name doesn't add meaning, it shouldn't exist as a named function.

Run the grep. If a handle function is used once, inline it.
