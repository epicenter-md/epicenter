<script lang="ts">
	import { buttonVariants } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import { Switch } from '@epicenter/ui/switch';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import { getTabManagerApp } from '$lib/context';

	const tabManager = getTabManagerApp();
	const trustedTools = $derived(tabManager.state.toolTrust.trustedToolNames);
	const actionTitles = tabManager.actions as Record<
		string,
		{ title?: string }
	>;
</script>

{#if trustedTools.length > 0}
	<Popover.Root>
		<Popover.Trigger
			class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
			title="Tool permissions"
		>
			<SettingsIcon class="size-4" />
		</Popover.Trigger>
		<Popover.Content class="w-72" align="end">
			<div class="space-y-3">
				<p class="text-sm font-medium">Tool Permissions</p>
				<div class="space-y-2">
					{#each trustedTools as name (name)}
						<div class="flex items-center justify-between gap-2">
							<span class="text-sm">
								{actionTitles[name]?.title ??
									name
										.replace(/_/g, ' ')
										.replace(/^\w/, (c) => c.toUpperCase())}
							</span>
							<Switch
								checked={true}
								onCheckedChange={() =>
									void tabManager.state.toolTrust.revoke(name)}
							/>
						</div>
					{/each}
				</div>
				{#if trustedTools.length > 1}
					<div class="border-t pt-2">
						<button
							class="text-xs text-muted-foreground hover:text-foreground transition-colors"
							onclick={() => {
								for (const toolName of trustedTools) {
									void tabManager.state.toolTrust.revoke(toolName);
								}
							}}
						>
							Revoke all
						</button>
					</div>
				{/if}
			</div>
		</Popover.Content>
	</Popover.Root>
{/if}
