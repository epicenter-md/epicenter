<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';

	let {
		label,
		otherLabel,
		otherHref,
	}: {
		label: 'On this device' | 'Across your devices';
		otherLabel: 'On this device' | 'Across your devices';
		otherHref: '/device' | '/account';
	} = $props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="sm"
				class="h-7 min-w-0 gap-1.5 px-2 text-xs text-muted-foreground"
				tooltip="Choose where notes live"
			>
				<span class="truncate">{label}</span>
				<ChevronsUpDownIcon class="size-3.5 shrink-0" />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="w-52">
		<DropdownMenu.Label>Notes</DropdownMenu.Label>
		<DropdownMenu.Item disabled>
			<CheckIcon class="mr-2 size-3.5" />
			{label}
		</DropdownMenu.Item>
		<DropdownMenu.Item>
			{#snippet child({ props })}
				<a {...props} href={otherHref} data-sveltekit-reload>
					<span class="mr-2 size-3.5"></span>
					{otherLabel}
				</a>
			{/snippet}
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
