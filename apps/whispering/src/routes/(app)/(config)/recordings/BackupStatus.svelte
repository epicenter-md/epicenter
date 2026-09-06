<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import CloudUploadIcon from '@lucide/svelte/icons/cloud-upload';
	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { resultQueryOptions } from 'wellcrafted/query';
	import { report } from '$lib/report';
	import { getWhisperingApp } from '$lib/whispering/context';

	/**
	 * What this account is still owed, and the one button that sends it.
	 *
	 * The count is the surface (ADR-0349): a manual button with no count lies by
	 * omission, and an automatic policy whose failures land in a toast that
	 * scrolled away lies the same way. The rows are the queue, so the number
	 * is synchronous; which of them this device can actually send takes one
	 * `stat` per owed row, which is what the survey does.
	 */
	const app = getWhisperingApp();
	const queryClient = useQueryClient();

	const pending = $derived(app.recordings.backup.pending);

	const survey = createQuery(() =>
		resultQueryOptions({
			// Keyed on the count, so a row landing or leaving re-surveys.
			queryKey: ['audio', 'backup', 'survey', pending],
			queryFn: () => app.recordings.backup.survey(),
			enabled: app.recordings.remoteAvailable && pending > 0,
		}),
	);

	const backUp = createMutation(() => ({
		mutationKey: ['audio', 'backup', 'kick'],
		mutationFn: () => app.recordings.backup.kick(),
		onSuccess: (result) => {
			if (result.uploaded > 0) {
				report.success({
					title: `Backed up ${result.uploaded} ${result.uploaded === 1 ? 'recording' : 'recordings'}`,
				});
				// Every row that moved changes its availability badge.
				void queryClient.invalidateQueries({ queryKey: ['audio', 'availability'] });
			}
			if (result.failed > 0) {
				report.info({
					title: `${result.failed} ${result.failed === 1 ? 'recording' : 'recordings'} could not be backed up`,
					description: result.aborted
						? 'Stopped early. Check your connection and sign-in, then try again.'
						: 'They stay on this device. Try again later.',
				});
			}
		},
	}));

	const noun = (count: number) => (count === 1 ? 'recording' : 'recordings');
</script>

{#if app.recordings.remoteAvailable}
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
		{#if pending === 0}
			<span>All recordings are backed up to your account.</span>
		{:else if survey.data}
			{@const { waiting, elsewhere } = survey.data}
			<span>
				{#if waiting > 0}
					{waiting} {noun(waiting)} on this device not backed up
				{:else}
					Nothing on this device is waiting to back up
				{/if}
				{#if elsewhere > 0}
					<span class="text-muted-foreground/70">
						({elsewhere} {noun(elsewhere)} waiting on another device)
					</span>
				{/if}
			</span>
			{#if waiting > 0}
				<Button
					variant="outline"
					size="sm"
					disabled={backUp.isPending}
					onclick={() => backUp.mutate()}
				>
					<CloudUploadIcon class="size-3.5" />
					{backUp.isPending ? 'Backing up...' : 'Back up now'}
				</Button>
			{/if}
		{:else}
			<span>{pending} {noun(pending)} not backed up</span>
		{/if}
	</div>
{/if}
