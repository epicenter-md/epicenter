<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import * as Kbd from '@epicenter/ui/kbd';
	import * as Popover from '@epicenter/ui/popover';
	import { cn } from '@epicenter/ui/utils';
	import Keyboard from '@lucide/svelte/icons/keyboard';
	import Pencil from '@lucide/svelte/icons/pencil';
	import XIcon from '@lucide/svelte/icons/x';
	import {
		getShortcutDisplayLabel,
		parseManualShortcut,
	} from '$lib/constants/keyboard';
	import { rpc } from '$lib/query';
	import { type KeyRecorder } from './create-key-recorder.svelte';

	const {
		title,
		placeholder = 'Press a key combination',
		autoFocus = true,
		rawKeyCombination,
		keyRecorder,
	}: {
		title: string;
		placeholder?: string;
		autoFocus?: boolean;
		rawKeyCombination: string | null;
		keyRecorder: KeyRecorder;
	} = $props();

	let isPopoverOpen = $state(false);
	let isManualMode = $state(false);
	let manualValue = $state(rawKeyCombination ?? '');

	$effect(() => {
		manualValue = rawKeyCombination ?? '';
	});
</script>

<div class="flex items-center justify-end gap-2">
	{#if rawKeyCombination}
		<Kbd.Root>{getShortcutDisplayLabel(rawKeyCombination)}</Kbd.Root>
		<Button
			variant="ghost"
			size="icon"
			class="size-8 shrink-0"
			onclick={() => keyRecorder.clear()}
		>
			<XIcon class="size-4" />
			<span class="sr-only">Clear shortcut</span>
		</Button>
	{:else}
		<span class="text-sm text-muted-foreground">Not set</span>
	{/if}

	<Popover.Root
		open={isPopoverOpen}
		onOpenChange={(isOpen) => {
			isPopoverOpen = isOpen;
			if (!isOpen) {
				keyRecorder.stop();
				isManualMode = false;
			}
			if (isOpen && autoFocus && !isManualMode) {
				keyRecorder.start();
			}
		}}
	>
		<Popover.Trigger>
			<Button variant="ghost" size="sm" class="h-8 font-normal">
				{#if rawKeyCombination}
					<span class="text-xs">Set shortcut</span>
				{:else}
					<span class="text-xs text-muted-foreground">+ Add</span>
				{/if}
			</Button>
		</Popover.Trigger>

		<Popover.Content
			class="w-80"
			align="end"
			onEscapeKeydown={(e) => {
				if (keyRecorder.isListening) {
					e.preventDefault();
				}
			}}
		>
			<div class="space-y-4">
				<div>
					<h4 class="mb-1 text-sm font-medium leading-none">{title}</h4>
					<p class="text-xs text-muted-foreground">
						{#if isManualMode}
							Enter shortcut manually (e.g., ctrl+shift+a)
						{:else}
							Click to record or edit manually
						{/if}
					</p>
				</div>

				{#if !isManualMode}
					<!-- Recording mode -->
					<button
						type="button"
						class={cn(
							'relative flex h-10 w-full items-center rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
							keyRecorder.isListening && 'ring-2 ring-ring ring-offset-2',
						)}
						onclick={(e) => {
							e.stopPropagation();
							keyRecorder.start();
						}}
						tabindex="0"
						aria-label={keyRecorder.isListening
							? 'Recording keyboard shortcut'
							: 'Click to record keyboard shortcut'}
					>
						<div class="flex w-full items-center justify-between">
							<div
								class="flex grow items-center gap-1.5 overflow-x-auto pr-2 scrollbar-none"
							>
								{#if rawKeyCombination && !keyRecorder.isListening}
									<Kbd.Root
										>{getShortcutDisplayLabel(rawKeyCombination)}</Kbd.Root
									>
								{:else if !keyRecorder.isListening}
									<span class="truncate text-muted-foreground"
										>{placeholder}</span
									>
								{/if}
							</div>
							{#if !keyRecorder.isListening}
								<Keyboard class="size-4 text-muted-foreground" />
							{/if}
						</div>

						{#if keyRecorder.isListening}
							<div
								class="absolute inset-0 z-10 flex animate-in fade-in-0 zoom-in-95 items-center justify-center rounded-md border border-input bg-background/95 backdrop-blur-sm"
								aria-live="polite"
							>
								<div class="flex flex-col items-center gap-1 px-4 py-2">
									<p class="text-sm font-medium">Press key combination</p>
									<p class="text-xs text-muted-foreground">Esc to cancel</p>
								</div>
							</div>
						{/if}
					</button>

					<div class="flex items-center gap-2">
						{#if rawKeyCombination}
							<Button
								variant="outline"
								size="sm"
								class="flex-1"
								onclick={() => keyRecorder.clear()}
							>
								<XIcon class="size-3" />
								Clear
							</Button>
						{/if}
						<Button
							variant="outline"
							size="sm"
							class={rawKeyCombination ? 'flex-1' : 'w-full'}
							onclick={() => {
								isManualMode = true;
								manualValue = rawKeyCombination ?? '';
								keyRecorder.stop();
							}}
						>
							<Pencil class="size-3" />
							Edit manually
						</Button>
					</div>
				{:else}
					<!-- Manual mode -->
					<form
						onsubmit={(e) => {
							e.preventDefault();
							if (!manualValue) return;
							const { keys, invalidTokens } = parseManualShortcut(manualValue);
							if (invalidTokens.length > 0) {
								rpc.notify.error({
									title: 'Invalid shortcut',
									description: `Could not recognize: ${invalidTokens.join(', ')}. Try aliases like ctrl, cmd, option, shift, space, or a single letter / digit / punctuation key.`,
								});
								return;
							}
							if (keys.length === 0) return;
							keyRecorder.register(keys);
							isManualMode = false;
						}}
						class="space-y-3"
					>
						<Input
							type="text"
							placeholder="e.g., ctrl+shift+a"
							bind:value={manualValue}
							class="font-mono text-sm"
							autofocus
						/>
						<div class="flex items-center gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								class="flex-1"
								onclick={() => {
									isManualMode = false;
									manualValue = rawKeyCombination ?? '';
								}}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								size="sm"
								class="flex-1"
								disabled={!manualValue}
							>
								Save
							</Button>
						</div>
					</form>
				{/if}
			</div>
		</Popover.Content>
	</Popover.Root>
</div>
