<script lang="ts">
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import { Label } from '@epicenter/ui/label';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import * as Popover from '@epicenter/ui/popover';
	import { Switch } from '@epicenter/ui/switch';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import { editorState } from '$lib/state/editor-state.svelte';
	import { terminalState } from '$lib/state/terminal-state.svelte';

	let { chatOpen = $bindable(false) }: { chatOpen: boolean } = $props();

	let popoverOpen = $state(false);
</script>

<div
	class="flex h-6 shrink-0 items-center gap-3 border-t bg-background px-3 text-xs text-muted-foreground"
>
	<span>Ln {editorState.cursorLine}, Col {editorState.cursorCol}</span>

	{#if editorState.selectionLength > 0}
		<span>{editorState.selectionLength} selected</span>
	{/if}

	<span>{editorState.wordCount} words</span>
	<span>{editorState.lineCount} lines</span>

	<div class="ml-auto flex items-center gap-1.5">
		<Tooltip.Provider>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant={terminalState.open ? 'secondary' : 'ghost'}
							size="sm"
							class="h-5 gap-1 px-1.5 text-xs text-muted-foreground"
							onclick={() => terminalState.toggle()}
						>
							<TerminalIcon class="size-3" />
							Terminal
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>Toggle terminal (\u2318`)</Tooltip.Content>
			</Tooltip.Root>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant={chatOpen ? 'secondary' : 'ghost'}
							size="sm"
							class="h-5 gap-1 px-1.5 text-xs text-muted-foreground"
							onclick={() => (chatOpen = !chatOpen)}
						>
							<MessageSquareIcon class="size-3" />
							AI Chat
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>Toggle AI chat (\u2318\u21e7L)</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>

		{#if editorState.vimEnabled}
			<span class="font-mono text-[10px] font-medium uppercase tracking-wider"
				>vim</span
			>
		{/if}

		<Popover.Root bind:open={popoverOpen}>
			<Popover.Trigger
				class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
			>
				<SettingsIcon class="size-3.5" />
			</Popover.Trigger>
			<Popover.Content class="w-64 space-y-3" align="end" side="top">
				<div class="flex items-center justify-between">
					<Label for="vim-mode" class="text-sm">Vim mode</Label>
					<Switch
						id="vim-mode"
						checked={editorState.vimEnabled}
						onCheckedChange={() => editorState.toggleVim()}
					/>
				</div>
				{#if editorState.vimEnabled}
					<p class="text-xs text-muted-foreground">
						Browser extensions like Vimium can intercept Escape and break vim
						keybindings\u2014disable them for this site if keys aren't working.
					</p>
				{/if}
				<div class="flex items-center justify-between">
					<span class="text-sm">Theme</span>
					<LightSwitch variant="ghost" />
				</div>
				<div class="border-t pt-3">
					<Button
						variant="ghost"
						size="sm"
						class="w-full justify-start"
						href="/about"
					>
						About Opensidian
					</Button>
				</div>
			</Popover.Content>
		</Popover.Root>
	</div>
</div>
