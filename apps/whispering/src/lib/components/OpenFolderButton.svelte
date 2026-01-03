<!--
	OpenFolderButton - Desktop-only button to open folders in the system file explorer.

	This component provides a consistent way to open folders across the app on desktop.
	It only renders on desktop (Tauri) environments and gracefully handles errors.

	Use cases:
	- Opening data folders (recordings, transformations, etc.)
	- Opening user-configured output directories
	- Providing quick access to app data locations

	Example usage:
	```svelte
	<OpenFolderButton
		getFolderPath={PATHS.DB.RECORDINGS}
		tooltipText="Open recordings folder"
	/>
	```

	@component
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { rpc } from '$lib/query';
	import { Ok, tryAsync } from 'wellcrafted/result';

	type Props = {
		/**
		 * Async function that returns the absolute path to the folder to open.
		 * This function is called when the button is clicked.
		 * Should throw an error if the path cannot be determined.
		 */
		getFolderPath: () => Promise<string>;

		/**
		 * Tooltip text shown on hover. Also used as button text when variant is 'default'.
		 */
		tooltipText: string;

		/**
		 * Visual variant of the button.
		 * - 'icon': Icon-only button (compact, for toolbars)
		 * - 'default': Button with icon and text label
		 */
		variant?: 'icon' | 'default';
	};

	let { getFolderPath, tooltipText, variant = 'icon' }: Props = $props();

	/**
	 * Opens the folder in the system's default file explorer.
	 * Only works on desktop (Tauri) environments.
	 * Shows error toast if opening fails.
	 */
	async function openFolder() {
		if (!window.__TAURI_INTERNALS__) return;

		await tryAsync({
			try: async () => {
				const { openPath } = await import('@tauri-apps/plugin-opener');
				const folderPath = await getFolderPath();
				await openPath(folderPath);
			},
			catch: (error) => {
				let description = 'Unknown error';
				if (typeof error === 'string') {
					description = error;
				} else if (error instanceof Error) {
					description = error.message;
				}

				rpc.notify.error.execute({
					title: 'Failed to open folder',
					description,
				});
				return Ok(undefined);
			},
		});
	}
</script>

{#if window.__TAURI_INTERNALS__}
	{#if variant === 'icon'}
		<Button
			tooltip={tooltipText}
			variant="outline"
			size="icon"
			onclick={openFolder}
		>
			<ExternalLink class="h-4 w-4" />
		</Button>
	{:else}
		<Button tooltip={tooltipText} variant="outline" onclick={openFolder}>
			<ExternalLink class="h-4 w-4" />
			{tooltipText}
		</Button>
	{/if}
{/if}
