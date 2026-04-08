<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import * as Tabs from '@epicenter/ui/tabs';
	import XIcon from '@lucide/svelte/icons/x';
	import GithubIcon from '$lib/components/icons/GithubIcon.svelte';
	import SyncStatusIndicator from '$lib/components/SyncStatusIndicator.svelte';
	import { fsState } from '$lib/state/fs-state.svelte';
</script>

<div class="flex items-center border-b">
	{#if fsState.hasOpenFiles}
		<Tabs.Root
			value={fsState.activeFileId ?? ''}
			onValueChange={(value) => fsState.selectFile(value as FileId)}
			class="flex-1 min-w-0"
		>
			<Tabs.List
				class="w-full justify-start overflow-x-auto rounded-none border-0 bg-transparent p-0"
			>
				{#each fsState.openFileIds as fileId (fileId)}
					{@const row = fsState.getFile(fileId)}
					{#if row}
						<Tabs.Trigger
							value={fileId}
							class="relative flex-none rounded-none border-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none"
							onauxclick={(e) => { if (e.button === 1) { e.preventDefault(); fsState.closeFile(fileId); } }}
						>
							<span class="mr-4">{row.name}</span>
							<Button
								variant="ghost"
								size="icon-xs"
								class="absolute right-1 top-1/2 -translate-y-1/2 opacity-50 hover:opacity-100"
								onclick={(e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); fsState.closeFile(fileId); }}
								aria-label="Close {row.name}"
							>
								<XIcon aria-hidden="true" class="size-3" />
							</Button>
						</Tabs.Trigger>
					{/if}
				{/each}
			</Tabs.List>
		</Tabs.Root>
	{/if}
	<div class="ml-auto flex shrink-0 items-center gap-1 px-2">
		<a
			href="https://github.com/EpicenterHQ/epicenter/tree/main/apps/opensidian"
			target="_blank"
			rel="noopener noreferrer"
			class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
			title="View source on GitHub"
		>
			<GithubIcon class="size-4" />
		</a>
		<SyncStatusIndicator />
	</div>
</div>
