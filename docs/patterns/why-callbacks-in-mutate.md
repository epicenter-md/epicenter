# Why I Pass Callbacks to .mutate() Instead of createMutation

I was refactoring some mutation handlers and realized I kept running into the same problem. My success callbacks needed access to local component state—dialog refs, form values, navigation state—but I was defining them at the mutation creation level where that context didn't exist.

Here's the thing that took me too long to realize: TanStack Query lets you pass callbacks at two different points, and where you put them matters.

## The Two Patterns

First, there's the pattern I was using:

```typescript
// Callbacks at mutation creation
const deleteSessionMutation = createMutation(() => ({
  ...rpc.sessions.deleteSession.options(),
  onSuccess: () => {
    // Can't access isDialogOpen here!
    toast.success('Deleted');
  }
}));
```

Then I discovered you can pass them when calling `.mutate()`:

```typescript
// Callbacks at call site
const deleteSessionMutation = createMutation(rpc.sessions.deleteSession.options);

// Later, when triggering the mutation
deleteSessionMutation.mutate({ sessionId }, {
  onSuccess: () => {
    isDialogOpen = false;  // Now I can access local state!
    toast.success('Deleted');
  }
});
```

That's it. No complex state management. No prop drilling. Just callbacks where they have the most context.

## Why This Works Better

When you're in a component and trigger a mutation, you usually want to do something with the UI afterward. Close a modal. Navigate somewhere. Update local state. Clear a form.

All of these things live in your component's scope. By defining callbacks at the call site, you get access to:

- Component state (`$state` variables)
- Props and derived values
- Other mutations and queries
- Navigation functions
- Refs to DOM elements

Here's a real example from a file upload dialog:

```svelte
<script lang="ts">
  const copyToClipboard = createMutation(rpc.clipboard.copyToClipboard.options);
  
  let isDialogOpen = $state(false);
  let selectedText = $state('');
</script>

<Button onclick={() => {
  copyToClipboard.mutate({ text: selectedText }, {
    onSuccess: () => {
      // Access to everything in component scope
      isDialogOpen = false;
      selectedText = '';
      toast.success('Copied to clipboard!');
    },
    onError: (error) => {
      // Even error handling can be contextual
      console.error('Failed to copy:', selectedText);
      toast.error(error.message);
    }
  });
}}>
  Copy
</Button>
```

## Different Actions, Different Behaviors

Another pattern that emerges: the same mutation might need different success behaviors in different contexts.

```typescript
// In a table row
deleteRecording.mutate(id, {
  onSuccess: () => toast.success('Recording deleted')
});

// In a bulk action
deleteRecording.mutate(id, {
  onSuccess: () => {
    remainingIds = remainingIds.filter(rid => rid !== id);
    if (remainingIds.length === 0) {
      isSelecting = false;
      toast.success('All recordings deleted!');
    }
  }
});
```

Same mutation. Different contexts. Different callbacks.

## The Loading State Still Works

You might worry that moving callbacks out of `createMutation` breaks something. It doesn't. You still get all the reactive state:

```svelte
const saveSettings = createMutation(rpc.settings.save.options);

<Button 
  disabled={saveSettings.isPending}
  onclick={() => {
    saveSettings.mutate(currentSettings, {
      onSuccess: () => {
        hasUnsavedChanges = false;
        toast.success('Settings saved');
      }
    });
  }}
>
  {#if saveSettings.isPending}
    Saving...
  {:else}
    Save
  {/if}
</Button>
```

Everything works exactly the same. You just have more flexibility.

## When to Break the Rule

Sometimes you do want callbacks at the mutation level. If every single call site needs identical behavior, put it there:

```typescript
// Audit logging on every call
const deleteSession = createMutation({
  ...rpc.sessions.deleteSession.options,
  onSuccess: (data) => {
    // This ALWAYS needs to happen
    logAuditEvent('session_deleted', data.id);
  }
});
```

But even then, you can still add call-site callbacks. They'll both run.

## The Pattern in Practice

After adopting this pattern, my components got simpler. No more passing callbacks through props. No more lifting state up just to access it in a success handler. 

Each mutation call is self-contained:

```typescript
shareMutation.mutate({ sessionId }, {
  onSuccess: ({ url }) => {
    shareUrl = url;
    isShareModalOpen = true;
    navigator.clipboard.writeText(url);
  }
});
```

You can read the click handler and understand everything that happens. The context is right there.

## The Lesson

Callbacks want context. Put them where the context lives.

I was treating mutation creation like a service definition—trying to define all behavior upfront. But mutations in components aren't services. They're UI interactions. And UI interactions need access to UI state.

So now I do this:
- `createMutation(rpc.thing.options)` - just the options, no callbacks
- `.mutate(data, { onSuccess, onError })` - callbacks with full context

Less abstraction. More clarity. And my modals finally close when they're supposed to.