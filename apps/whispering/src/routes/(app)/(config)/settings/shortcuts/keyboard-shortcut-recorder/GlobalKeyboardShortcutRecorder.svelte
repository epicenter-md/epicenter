<script lang="ts">
	import type { Command } from '$lib/commands';
	import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
	import { rpc } from '$lib/query';
	import { desktopRpc } from '$lib/query/desktop';
	import {
		type Accelerator,
		pressedKeysToTauriAccelerator,
	} from '$lib/services/desktop/global-shortcut-manager';
	import { deviceConfig } from '$lib/state/device-config.svelte';
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

	const shortcutValue = $derived(
		deviceConfig.get(`shortcuts.global.${command.id}`),
	);

	const keyRecorder = createKeyRecorder({
		pressedKeys,
		onRegister: async (keyCombination: KeyboardEventSupportedKey[]) => {
			if (shortcutValue) {
				const { error: unregisterError } =
					await desktopRpc.globalShortcuts.unregisterCommand({
						accelerator: shortcutValue as Accelerator,
					});

				if (unregisterError) {
					rpc.notify.error({
						title: 'Failed to unregister shortcut',
						description:
							'Could not unregister the global shortcut. It may already be in use by another application.',
						action: { type: 'more-details', error: unregisterError },
					});
				}
			}

			const { data: accelerator, error: acceleratorError } =
				pressedKeysToTauriAccelerator(keyCombination);

			if (acceleratorError) {
				rpc.notify.error({
					title: 'Invalid shortcut combination',
					description: `The key combination "${keyCombination.join('+')}" is not valid. Please try a different combination.`,
					action: { type: 'more-details', error: acceleratorError },
				});
				return;
			}

			const { error: registerError } =
				await desktopRpc.globalShortcuts.registerCommand({
					command,
					accelerator,
				});

			if (registerError) {
				switch (registerError.name) {
					case 'InvalidFormat':
					case 'NoKeyCode':
					case 'MultipleKeyCodes':
					case 'GeneratedInvalid':
						rpc.notify.error({
							title: 'Invalid shortcut combination',
							description: `The key combination "${keyCombination.join('+')}" is not valid. Please try a different combination.`,
							action: { type: 'more-details', error: registerError },
						});
						break;
					default:
						rpc.notify.error({
							title: 'Failed to register shortcut',
							description:
								'Could not register the global shortcut. It may already be in use by another application.',
							action: { type: 'more-details', error: registerError },
						});
						break;
				}
				return;
			}

			deviceConfig.set(`shortcuts.global.${command.id}`, accelerator);

			rpc.notify.success({
				title: `Global shortcut set to ${accelerator}`,
				description: `Press the shortcut to trigger "${command.title}"`,
			});
		},
		onClear: async () => {
			const { error: unregisterError } =
				await desktopRpc.globalShortcuts.unregisterCommand({
					accelerator: shortcutValue as Accelerator,
				});

			if (unregisterError) {
				rpc.notify.error({
					title: 'Error clearing global shortcut',
					description: 'Could not clear the global shortcut.',
					action: { type: 'more-details', error: unregisterError },
				});
			}

			deviceConfig.set(`shortcuts.global.${command.id}`, null);

			rpc.notify.success({
				title: 'Global shortcut cleared',
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
