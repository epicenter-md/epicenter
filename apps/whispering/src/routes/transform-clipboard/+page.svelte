<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
	import TransformationPickerBody from '$lib/components/TransformationPickerBody.svelte';
	import { rpc } from '$lib/query';
	import * as transformClipboardWindow from './transformClipboardWindow.tauri';
	import { Textarea } from '@repo/ui/textarea';
	import * as Popover from '@repo/ui/popover';
	import { useCombobox } from '@repo/ui/hooks';
	import { Button } from '@repo/ui/button';
	import { LayersIcon } from '@lucide/svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { nanoid } from 'nanoid/non-secure';

	const combobox = useCombobox();

	const clipboardQuery = createQuery(() => ({
		...rpc.text.readFromClipboard.options(),
		refetchInterval: 1000,
	}));

	const clipboardText = $derived(clipboardQuery.data ?? '');

	let unlistenOpenCombobox: UnlistenFn | null = null;

	// Listen for event to open combobox
	onMount(async () => {
		unlistenOpenCombobox = await listen(
			'transform-clipboard-open-combobox',
			() => {
				// Try to focus the window
				const currentWindow = WebviewWindow.getCurrent();
				currentWindow.setFocus().catch(() => {
					// setFocus often fails on macOS, ignore the error
				});

				// Open the combobox
				combobox.open = true;
			},
		);
	});

	onDestroy(() => {
		unlistenOpenCombobox?.();
	});

	// Auto-open popover when clipboard has text
	$effect(() => {
		if (clipboardQuery.isSuccess && clipboardText.trim()) {
			combobox.open = true;
		}
	});

	$effect(() => {
		if (!window.__TAURI_INTERNALS__) return;

		if (clipboardQuery.error) {
			rpc.notify.error.execute({
				title: '❌ Failed to read clipboard',
				description: clipboardQuery.error.message,
				action: { type: 'more-details', error: clipboardQuery.error },
			});
			void transformClipboardWindow.hide();
		}

		if (clipboardQuery.isSuccess && !clipboardQuery.data?.trim()) {
			rpc.notify.info.execute({
				title: 'Empty clipboard',
				description: 'Please copy some text before running a transformation.',
			});
			void transformClipboardWindow.hide();
		}
	});
</script>

<div class="flex h-screen flex-col p-6 gap-4">
	<div class="space-y-2">
		<h2 class="text-2xl font-semibold">Transform Clipboard</h2>
		<p class="text-sm text-muted-foreground">
			Select a transformation to apply to your clipboard text
		</p>
	</div>

	{#if clipboardQuery.isPending}
		<div class="flex min-h-32 items-center justify-center">
			<p class="text-sm text-muted-foreground">Reading clipboard...</p>
		</div>
	{:else}
		<Textarea
			value={clipboardText}
			readonly
			class="min-h-32 resize-none font-mono text-sm"
		/>
	{/if}

	<Popover.Root bind:open={combobox.open}>
		<Popover.Trigger bind:ref={combobox.triggerRef}>
			{#snippet child({ props })}
				<Button
					{...props}
					role="combobox"
					aria-expanded={combobox.open}
					variant="outline"
					class="w-full justify-start gap-2"
				>
					<LayersIcon class="size-4" />
					Select Transformation
				</Button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content class="w-[var(--bits-popover-anchor-width)] p-0">
			<TransformationPickerBody
				onSelect={async (transformation) => {
					if (!clipboardText) return;

					combobox.closeAndFocusTrigger();

					const toastId = nanoid();
					rpc.notify.loading.execute({
						id: toastId,
						title: '🔄 Running transformation...',
						description: 'Transforming your clipboard text...',
					});

					const { data: output, error: transformError } =
						await rpc.transformer.transformInput.execute({
							input: clipboardText,
							transformation,
						});

					if (transformError) {
						rpc.notify.error.execute({ id: toastId, ...transformError });
						await transformClipboardWindow.hide();
						return;
					}

					rpc.sound.playSoundIfEnabled.execute('transformationComplete');

					await rpc.delivery.deliverTransformationResult.execute({
						text: output,
						toastId,
					});

					await transformClipboardWindow.hide();
				}}
				onSelectManageTransformations={async () => {
					combobox.closeAndFocusTrigger();
					await transformClipboardWindow.hide();
					await emit('navigate-main-window', { path: '/transformations' });
				}}
				placeholder="Search transformations..."
			/>
		</Popover.Content>
	</Popover.Root>
</div>
