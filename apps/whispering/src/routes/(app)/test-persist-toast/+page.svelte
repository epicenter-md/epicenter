<script lang="ts">
	import { Button } from '@repo/ui/button';
	import { notify } from '$lib/query/notify';

	let persistentToastId: string | undefined;

	function showPersistentToast() {
		persistentToastId = notify.error.mutate({
			title: 'Persistent Error',
			description: 'This toast will stay visible until you dismiss it',
			persist: true,
			action: {
				type: 'button',
				label: 'Dismiss',
				onClick: () => {
					if (persistentToastId) {
						notify.dismiss(persistentToastId);
						persistentToastId = undefined;
					}
				},
			},
		});
	}

	function showNormalToast() {
		notify.success.mutate({
			title: 'Normal Toast',
			description: 'This will auto-dismiss after 3 seconds',
		});
	}

	function showPersistentLoadingToast() {
		persistentToastId = notify.loading.mutate({
			title: 'Loading Forever...',
			description: 'This loading toast persists until dismissed',
			persist: true,
		});
	}
</script>

<div class="flex flex-col gap-4 p-8">
	<h1 class="text-2xl font-bold">Test Persistent Toast</h1>

	<div class="flex gap-4">
		<Button onclick={showPersistentToast}>Show Persistent Error</Button>

		<Button onclick={showNormalToast} variant="secondary">
			Show Normal Toast
		</Button>

		<Button onclick={showPersistentLoadingToast} variant="outline">
			Show Persistent Loading
		</Button>

		{#if persistentToastId}
			<Button
				onclick={() => {
					notify.dismiss(persistentToastId);
					persistentToastId = undefined;
				}}
				variant="destructive"
			>
				Dismiss Persistent Toast
			</Button>
		{/if}
	</div>
</div>
