<script lang="ts">
	import type { Command } from '$lib/commands';
	import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
	import { rpc } from '$lib/query';
	import {
		type CommandId,
		arrayToShortcutString,
	} from '$lib/services/local-shortcut-manager';
	import { settings } from '$lib/stores/settings.svelte';
	import { type PressedKeys } from '$lib/utils/createPressedKeys.svelte';
	import KeyboardShortcutRecorder from './KeyboardShortcutRecorder.svelte';
	import { createKeyRecorder } from './create-key-recorder.svelte';

	const {
		command,
		placeholder,
		autoFocus = true,
		pressedKeys,
	}: {
		command: Command;
		placeholder?: string;
		autoFocus?: boolean;
		pressedKeys: PressedKeys;
	} = $props();

	const shortcutValue = $derived(
		settings.value[`shortcuts.local.${command.id}`],
	);

	const keyRecorder = createKeyRecorder({
		pressedKeys,
		onRegister: async (keyCombination: KeyboardEventSupportedKey[]) => {
			const { error: unregisterError } =
				await rpc.shortcuts.unregisterCommandLocally.execute({
					commandId: command.id as CommandId,
				});
			if (unregisterError) {
				rpc.notify.error.execute({
					title: 'Error unregistering local shortcut',
					description: unregisterError.message,
					action: { type: 'more-details', error: unregisterError },
				});
			}
			const { error: registerError } =
				await rpc.shortcuts.registerCommandLocally.execute({
					command,
					keyCombination,
				});

			if (registerError) {
				rpc.notify.error.execute({
					title: 'Error registering local shortcut',
					description: registerError.message,
					action: { type: 'more-details', error: registerError },
				});
				return;
			}

			settings.updateKey(
				`shortcuts.local.${command.id}`,
				arrayToShortcutString(keyCombination),
			);

			rpc.notify.success.execute({
				title: `Local shortcut set to ${keyCombination}`,
				description: `Press the shortcut to trigger "${command.title}"`,
			});
		},
		onClear: async () => {
			const { error: unregisterError } =
				await rpc.shortcuts.unregisterCommandLocally.execute({
					commandId: command.id as CommandId,
				});
			if (unregisterError) {
				rpc.notify.error.execute({
					title: 'Error clearing local shortcut',
					description: unregisterError.message,
					action: { type: 'more-details', error: unregisterError },
				});
			}
			settings.updateKey(`shortcuts.local.${command.id}`, null);

			rpc.notify.success.execute({
				title: 'Local shortcut cleared',
				description: `Please set a new shortcut to trigger "${command.title}"`,
			});
		},
	});
</script>

<KeyboardShortcutRecorder
	title={command.title}
	{placeholder}
	{autoFocus}
	rawKeyCombination={shortcutValue}
	{keyRecorder}
/>
