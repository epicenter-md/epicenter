<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import { goto } from '$app/navigation';
	import { auth } from '#platform/auth';
	import { whisperingPath } from '$lib/constants/urls';

	let errorMessage = $state<string | null>(null);

	$effect(() => {
		void (async () => {
			const { error } = await auth.startSignIn();
			if (error) {
				errorMessage = error.message;
				return;
			}
			await goto(whisperingPath('/'), { replaceState: true });
		})();
	});
</script>

{#if errorMessage}
	<div
		class="flex h-dvh items-center justify-center px-6 text-center text-sm text-destructive"
	>
		{errorMessage}
	</div>
{:else}
	<Loading class="h-dvh" label="Signing in…" />
{/if}
