<script lang="ts">
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import { Button } from '@epicenter/ui/button';
	import { Link } from '@epicenter/ui/link';
	import { resolve } from '$app/paths';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { auth } from '#platform/auth';
	import { instanceSetting } from '#platform/instance';
	import { bootFailureMessage } from '$lib/boot-failure.js';

	let { error = undefined }: { error?: unknown } = $props();
</script>

<div class="flex h-dvh items-center justify-center p-6 text-center">
	<div class="flex max-w-sm flex-col items-center gap-4">
		<div class="space-y-2">
			<h1 class="text-lg font-semibold">Across your devices</h1>
			<p class="text-sm text-muted-foreground">
				{error
					? bootFailureMessage(error, 'account')
					: 'Sign in to open the notes that follow you across your devices.'}
			</p>
			{#if error}
				<p class="text-xs text-muted-foreground/70">{extractErrorMessage(error)}</p>
			{/if}
		</div>

		<AccountPopover
			{auth}
			syncNoun="notes"
			instanceConnect={{ appName: 'Honeycrisp', setting: instanceSetting }}
		>
			{#snippet trigger({ props })}
				<Button {...props} size="lg">
					{error ? 'Reconnect' : 'Sign in to continue'}
				</Button>
			{/snippet}
		</AccountPopover>

		<Link href={resolve('/device')}>Keep working On this device</Link>
	</div>
</div>
