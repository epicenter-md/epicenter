# The Hidden Trap of Read-Only Settings and Svelte 5 Function Bindings

I was building a settings panel for FFmpeg recording options in Whispering. Simple enough: dropdowns for audio format, sample rate, bitrate. The user picks their settings, they get saved to localStorage, everyone's happy.

Except the settings weren't persisting. Not on refresh. Not even when the window lost focus.

Here's the thing that took me too long to realize: I had a read-only getter that looked writable.

## The Deceptive Settings Store

My settings store looked innocent enough:

```typescript
export const settings = (() => {
  const _settings = createPersistedState({
    key: 'whispering-settings',
    schema: settingsSchema,
    // ...
  });

  return {
    get value(): Settings {
      return _settings.value;
    },
    
    updateKey<K extends keyof Settings>(key: K, value: Settings[K]) {
      _settings.value = { ..._settings.value, [key]: value };
    }
  };
})();
```

Notice the pattern? `settings.value` is a getter. Read-only. You can't do `settings.value['some.key'] = newValue`. You have to use `settings.updateKey('some.key', newValue)`.

## The Binding That Wasn't

In my parent component, I had been using the obvious approach:

```svelte
<FfmpegCommandBuilder
  bind:globalOptions={settings.value['recording.ffmpeg.globalOptions']}
  bind:inputOptions={settings.value['recording.ffmpeg.inputOptions']}
  bind:outputOptions={settings.value['recording.ffmpeg.outputOptions']}
/>
```

This *looks* like it should work. The child component gets `$bindable()` props, the parent binds to them. Classic Svelte two-way binding.

But here's what actually happens:
1. The initial value gets passed to the child (works fine)
2. The child updates its local `outputOptions` variable (works fine)
3. Svelte tries to write back to `settings.value['recording.ffmpeg.outputOptions']` (fails silently)

Why does it fail? Because `settings.value` returns a new object each time. There's no setter. The binding is trying to mutate a read-only getter result.

## Enter Function Bindings

Svelte 5 introduced [function bindings](https://svelte.dev/docs/svelte/bind#Function-bindings), and they're perfect for this exact scenario. Instead of binding to a value, you bind to a getter/setter pair:

```svelte
<FfmpegCommandBuilder
  bind:globalOptions={
    () => settings.value['recording.ffmpeg.globalOptions'],
    (v) => settings.updateKey('recording.ffmpeg.globalOptions', v)
  }
  bind:inputOptions={
    () => settings.value['recording.ffmpeg.inputOptions'],
    (v) => settings.updateKey('recording.ffmpeg.inputOptions', v)
  }
  bind:outputOptions={
    () => settings.value['recording.ffmpeg.outputOptions'],
    (v) => settings.updateKey('recording.ffmpeg.outputOptions', v)
  }
/>
```

Now when the child component reads `globalOptions`, it calls our getter. When it writes to `globalOptions = newValue`, it calls our setter. The setter calls `updateKey`, which properly updates the store and persists to localStorage.

## The Beauty of Keeping bind:

The best part? The child component doesn't change at all:

```svelte
// Child component - still uses simple $bindable()
let {
  globalOptions = $bindable(),
  inputOptions = $bindable(),
  outputOptions = $bindable(),
} = $props();

// Updates work exactly as before
function rebuildOutputOptionsFromSelections() {
  outputOptions = `-acodec ${codec} -ar ${sampleRate}`;
  // This now calls our setter function!
}
```

We keep the clean `bind:` syntax throughout. The child component doesn't need to know about our settings store architecture. It just binds to values like any other Svelte component.

## The Lesson

When you have a read-only getter with a separate update method, function bindings are your bridge. They let you transform the binding interface at the parent level while keeping child components simple.

No callbacks. No prop drilling. No `onGlobalOptionsChange` handlers. Just clean, declarative bindings that work with your store's API.

The settings persist now. Focus, blur, refresh—they survive it all. Sometimes the fix isn't about restructuring everything. It's about finding the right adapter pattern. Function bindings are that adapter.