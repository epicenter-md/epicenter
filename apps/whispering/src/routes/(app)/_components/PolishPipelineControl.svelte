<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Link } from '@epicenter/ui/link';
	import * as Popover from '@epicenter/ui/popover';
	import { cn } from '@epicenter/ui/utils';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import { SettingSwitch } from '$lib/components/settings';
	import { polishStatus } from '$lib/operations/run-polish';

	// The post-transcription stage of the capture pipeline, surfaced beside the
	// model selector so the delivered output's mode (raw vs polished) is legible
	// at the moment of dictation, not hidden behind the generic options popover.
	// Polish's effective state has two inputs, intent and a completion key, so the
	// chip shows all three resolved states; `needs-key` is the one a bare boolean
	// used to hide. Reads `polishStatus` at use, so it tracks the toggle and the
	// key together.
	let open = $state(false);

	const status = $derived(polishStatus());

	const meta = $derived(
		{
			on: {
				label: 'Polish',
				tooltip: 'Polish is on: transcripts are cleaned up with AI',
				Icon: SparklesIcon,
				triggerClass: 'text-foreground',
				iconClass: 'text-sky-500',
			},
			off: {
				label: 'Raw',
				tooltip: 'Speed mode: the raw transcript ships instantly',
				Icon: SparklesIcon,
				triggerClass: 'text-muted-foreground',
				iconClass: 'text-muted-foreground',
			},
			'needs-key': {
				label: 'Polish',
				tooltip: 'Polish is on but needs an AI key. Transcripts ship raw',
				Icon: KeyRoundIcon,
				triggerClass: 'text-amber-600 dark:text-amber-500',
				iconClass: 'text-amber-500',
			},
		}[status],
	);
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				tooltip={meta.tooltip}
				aria-label="Polish settings"
				aria-expanded={open}
				variant="ghost"
				size="sm"
				class={cn('gap-1.5 px-2', meta.triggerClass)}
			>
				<meta.Icon class={cn('size-4', meta.iconClass)} />
				<span class="text-sm">{meta.label}</span>
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80">
		<div class="flex flex-col gap-3">
			<SettingSwitch
				key="polish.enabled"
				label="Polish transcripts with AI"
				description="An always-on AI pass that fixes grammar and punctuation while keeping your wording. Turn off for speed mode: instant raw transcript, no AI call."
			/>

			{#if status === 'needs-key'}
				<div
					class="border-amber-500/30 bg-amber-500/10 text-foreground flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm"
				>
					<KeyRoundIcon class="mt-0.5 size-4 shrink-0 text-amber-500" />
					<p>
						No AI key, so transcripts still ship raw. <Link
							href="/settings/api-keys">Add a completion key</Link
						> to start polishing.
					</p>
				</div>
			{/if}

			<p class="text-muted-foreground text-sm">
				Edit the Polish instruction and Dictionary under <Link
					href="/settings/dictation">Dictation settings</Link
				>.
			</p>
		</div>
	</Popover.Content>
</Popover.Root>
