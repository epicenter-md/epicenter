<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import { auth } from '#platform/auth';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	let errorMessage = $state<string | null>(null);

	$effect(() => {
		void (async () => {
			const { error } = await auth.startSignIn();
			if (error) {
				errorMessage = error.message;
				return;
			}
			await goto(resolve('/account'), { replaceState: true });
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
