/**
 * Custom hook for managing combobox state with shadcn-svelte's Command and Popover components.
 *
 * This hook provides the necessary state management for creating accessible comboboxes
 * that follow the ARIA combobox pattern. It handles opening/closing the dropdown and
 * refocusing the trigger button after selection.
 *
 * Usage example:
 * ```svelte
 * <script lang="ts">
 *   import * as Command from '@epicenter/ui/command';
 *   import * as Popover from '@epicenter/ui/popover';
 *   import { useCombobox } from '@epicenter/ui/hooks';
 *
 *   const combobox = useCombobox();
 * </script>
 *
 * <Popover.Root bind:open={combobox.open}>
 *   <Popover.Trigger bind:ref={combobox.triggerRef}>
 *     {#snippet child({ props })}
 *       <Button {...props} role="combobox" aria-expanded={combobox.open}>
 *         Select an option
 *       </Button>
 *     {/snippet}
 *   </Popover.Trigger>
 *   <Popover.Content>
 *     <Command.Root>
 *       <Command.Input placeholder="Search..." />
 *       <Command.List>
 *         <Command.Item onSelect={() => {
 *           // Handle selection
 *           combobox.closeAndFocusTrigger();
 *         }}>
 *           Option 1
 *         </Command.Item>
 *       </Command.List>
 *     </Command.Root>
 *   </Popover.Content>
 * </Popover.Root>
 * ```
 */
import { tick } from 'svelte';

export function useCombobox() {
	let open = $state(false);
	let triggerRef = $state<HTMLButtonElement | null>(null);

	return {
		closeAndFocusTrigger() {
			open = false;
			tick().then(() => {
				triggerRef?.focus();
			});
		},
		get open() {
			return open;
		},
		set open(value) {
			open = value;
		},
		get triggerRef() {
			return triggerRef;
		},
		set triggerRef(value) {
			triggerRef = value;
		},
	};
}
