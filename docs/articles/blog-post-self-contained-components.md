# The Day I Stopped Managing Dialog State in Parent Components

I was building a workspace management UI last week. Simple table, each row had edit and delete buttons. You know the drill.

My first instinct was to add state at the parent level:

```svelte
let deletingWorkspace = $state(null);
let editingWorkspace = $state(null);
```

Then wire up the buttons to set these values, render a single dialog at the bottom, check which workspace we're operating on... The usual dance.

But something felt off: I had two state variables just to track which modals were open. The parent component was getting cluttered with modal management logic that had nothing to do with displaying workspaces.

## The Realization

Here's what hit me:

 ___Why am I managing modal state at the parent level when each row could just... have its own delete button with its own dialog?___

So I created `DeleteWorkspaceButton.svelte`:

```svelte
<script lang="ts">
  import { Button } from '@epicenter/ui/button';
  import * as AlertDialog from '@epicenter/ui/alert-dialog';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  
  let { workspace } = $props();
  let open = $state(false);
  
  function handleDelete() {
    workspaces.value = workspaces.value.filter(w => w.id !== workspace.id);
    open = false;
    toast.success('Deleted workspace');
  }
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Trigger>
    <Button size="icon" variant="ghost">
      <Trash2 class="h-4 w-4" />
    </Button>
  </AlertDialog.Trigger>
  <AlertDialog.Content>
    <!-- confirmation dialog -->
  </AlertDialog.Content>
</AlertDialog.Root>
```

The parent component became dead simple:

```svelte
{#each workspaces.value as workspace}
  <Table.Row>
    <!-- other cells -->
    <DeleteWorkspaceButton {workspace} />
  </Table.Row>
{/each}
```

## Why This Feels Wrong (But Isn't)

Your brain might be screaming: _"But you're creating 50 dialog instances for 50 rows! That's inefficient!"_

Except it's not. Modern frameworks are really good at this. Svelte doesn't actually render 50 dialogs to the DOM. The dialog only exists when it's open. What you're "duplicating" is just component instances in memory, which is negligible.

What you gain:
- Zero state management in the parent.
- No callbacks to pass around.
- Each button is completely self-contained.
- Adding a new action (edit, duplicate, archive) doesn't touch the parent.

## The Pattern

I've started applying this everywhere:

**Before**: Parent manages state for child interactions.
```svelte
<!-- Parent tracks which item is being edited -->
let editingItem = null;
let deletingItem = null;

function handleEdit(item) { /* ... */ }
function handleDelete(item) { /* ... */ }
```

**After**: Children manage their own interactions.
```svelte
<!-- Each child handles its own state -->
<EditButton {item} />
<DeleteButton {item} />
```

## When This Works

This pattern shines when:
- You have repeated UI elements (table rows, list items, cards)
- Each element needs modal interactions (delete confirmations, edit forms)
- You're passing callbacks just to update parent state
- The parent component is getting polluted with modal management

## The Mental Model Shift

The key insight: Stop thinking about "one dialog for the whole table." Start thinking about "each row has its own delete capability."

It's the same shift we made with component state years ago. We stopped putting all state in a global store and learned to colocate state with the components that use it.

This is just taking that principle one step further: colocate modal interactions with the elements that trigger them.

## A Real Example

Here's the actual PR where I made this change: I removed 30 lines of state management code from the parent and replaced it with a 40-line self-contained component. The parent component is now just focused on what it should be: displaying workspaces.

The lesson: Sometimes the "inefficient" approach is actually the clean approach. And clean code is usually more efficient in the ways that matter: developer time, bug surface area, and cognitive load.

Next time you find yourself managing modal state in a parent component, ask yourself: could this just be a self-contained component instead?

Trust me, your future self will thank you when adding that archive button doesn't require threading three new props through your component tree.