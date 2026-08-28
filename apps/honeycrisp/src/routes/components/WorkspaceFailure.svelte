<script lang="ts">
	import { Link } from '@epicenter/ui/link';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { bootFailureMessage } from '$lib/boot-failure.js';

	let {
		workspace,
		error,
	}: { workspace: 'local' | 'account'; error: unknown } = $props();

	const otherHref = $derived(workspace === 'account' ? '/device' : '/account');
	const otherLabel = $derived(
		workspace === 'account' ? 'On this device' : 'Across your devices',
	);
</script>

<div class="flex h-dvh items-center justify-center p-6 text-center">
	<div class="max-w-md space-y-3">
		<h1 class="text-lg font-semibold">Honeycrisp could not start</h1>
		<p class="text-sm text-muted-foreground">
			{bootFailureMessage(error, workspace)}
		</p>
		<p class="text-xs text-muted-foreground/70">
			{extractErrorMessage(error)}
		</p>
		<Link href={otherHref}>{otherLabel}</Link>
	</div>
</div>
