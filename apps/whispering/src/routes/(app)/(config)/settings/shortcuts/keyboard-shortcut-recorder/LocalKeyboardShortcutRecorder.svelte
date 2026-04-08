<script lang="ts">
	import type { Command } from '$lib/commands';
	import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
	import { rpc } from '$lib/query';
	import {
		arrayToShortcutString,
		type CommandId,
	} from '$lib/services/local-shortcut-manager';
	import { settings } from '$lib/state/settings.svelte';
	import { type PressedKeys } from '$lib/utils/createPressedKeys.svelte';
	import { createKeyRecorder } from './create-key-recorder.svelte';
	import KeyboardShortcutRecorder from './KeyboardShortcutRecorder.svelte';

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

	const shortcutValue = $derived(settings.get(`shortcut.${command.id}`));

	const keyRecorder = createKeyRecorder({
		pressedKeys,
		onRegister: async (keyCombination: KeyboardEventSupportedKey[]) => {
			const { error: unregisterError } =
				await rpc.localShortcuts.unregisterCommand({
					commandId: command.id as CommandId,
				});
			if (unregisterError) {
				rpc.notify.error({
					title: 'Error unregistering local shortcut',
					description: unregisterError.message,
					action: { type: 'more-details', error: unregisterError },
				});
			}
			const { error: registerError } = await rpc.localShortcuts.registerCommand(
				{
					command,
					keyCombination,
				},
			);

			if (registerError) {
				rpc.notify.error({
					title: 'Error registering local shortcut',
					description: registerError.message,
					action: { type: 'more-details', error: registerError },
				});
				return;
			}

			settings.set(
				`shortcut.${command.id}`,
				arrayToShortcutString(keyCombination),
			);

			rpc.notify.success({
				title: `Local shortcut set to ${keyCombination}`,
				description: `Press the shortcut to trigger "${command.title}"`,
			});
		},
		onClear: async () => {
			const { error: unregisterError } =
				await rpc.localShortcuts.unregisterCommand({
					commandId: command.id as CommandId,
				});
			if (unregisterError) {
				rpc.notify.error({
					title: 'Error clearing local shortcut',
					description: unregisterError.message,
					action: { type: 'more-details', error: unregisterError },
				});
			}
			settings.set(`shortcut.${command.id}`, null);

			rpc.notify.success({
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
