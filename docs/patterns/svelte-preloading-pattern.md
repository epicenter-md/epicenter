# Stop Fighting the Framework: Preload Your Data

I was building a session detail page and fell into the classic trap. You know the one.

```svelte
<script lang="ts">
  // .../src/routes/workspaces/[id]/sessions/[sessionId]/+page.svelte
  const workspaceId = $derived($page.params.id);
  const workspace = $derived(getWorkspace(workspaceId));
  
  // Redirect if workspace not found
  $effect(() => {
    if (!workspace) {
      goto('/workspaces');
    }
  });
  
  // Now I have to check workspace everywhere
  const sessionQuery = $derived(
    workspace
      ? createQuery(/* ... */)
      : null
  );
</script>

{#if workspace && sessionQuery}
  <!-- My actual UI -->
{/if}
```

Every. Single. Thing. Needs a null check. The workspace might not exist. The query might be null. My component logic is littered with conditional checks.

Here's the thing that took me too long to realize: I was treating synchronous data like it was async. I was adding defensive programming where none was needed.

The workspace check is synchronous. It's just a lookup in a store. Why am I wrapping it in effects and derived state?

## The Better Way

Move the check to `+page.ts`:

```typescript
// .../src/routes/workspaces/[id]/sessions/[sessionId]/+page.ts
export const load: PageLoad = async ({ params }) => {
  const workspace = getWorkspace(params.id);
  
  if (!workspace) {
    redirect(302, '/workspaces');
  }
  
  return {
    workspace,
    sessionId: params.sessionId
  };
};
```

Now in the component:

```svelte
<script lang="ts">
  let { data } = $props();
  const workspace = $derived(data.workspace);
  const sessionId = $derived(data.sessionId);
  
  // No null checks needed!
  const sessionQuery = createQuery(
    rpc.sessions.getSessionById(
      () => workspace,
      () => sessionId,
    ).options,
  );
</script>

<!-- No conditional rendering needed -->
<MessageList messages={messages.value} />
```

That's it. No conditional logic. No null checks. No effects watching for redirects.

## Why This Works

Even in an SPA, `+page.ts` runs before your component renders. It's the perfect place for:

1. Synchronous data fetching (like store lookups)
2. Guard checks and redirects
3. Data transformation

The component gets clean, validated data. No defensive programming needed.

## The Pattern

Think of it this way:

- **`+page.ts`**: Guard at the door. Check credentials. Redirect if needed.
- **Component**: Trust the data. Focus on UI logic.

I was treating every component like it needed to verify its own data. But that's what the routing layer is for.

## When to Use This

This pattern shines when:

- You have synchronous data lookups (stores, localStorage, etc.)
- The data determines if the page should even render
- Multiple parts of your component need the same data
- You're tired of null checks everywhere

## The Lesson

Not every data access needs defensive programming. If you can check something synchronously before the component renders, do it in the loader. Your components will thank you.

The framework gives you these tools. Use them.