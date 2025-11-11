<script lang="ts">
	import { confirmationDialog } from '$lib/components/ConfirmationDialog.svelte';
	import { Button } from '@repo/ui/button';
	import { Link } from '@repo/ui/link';
	import { Separator } from '@repo/ui/separator';
	import { rpc } from '$lib/query';
	import { RotateCcw } from '@lucide/svelte';
	import SidebarNav from './SidebarNav.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { useSidebar } from '@repo/ui/sidebar';

	let { children } = $props();

	const sidebar = useSidebar();

	const isString = (value: unknown): value is string =>
		typeof value === 'string';
	const versionPromise = (async () => {
		const res = await fetch(
			'https://api.github.com/repos/epicenter-md/epicenter/releases/latest',
		);
		const { html_url: latestReleaseUrl, tag_name: latestVersion } =
			await res.json();
		if (!isString(latestVersion) || !isString(latestReleaseUrl)) {
			throw new Error('Failed to fetch latest version');
		}
		if (!window.__TAURI_INTERNALS__)
			return { isOutdated: false, version: latestVersion } as const;
		const { getVersion } = await import('@tauri-apps/api/app');
		const currentVersion = `v${await getVersion()}`;
		if (latestVersion === currentVersion) {
			return { isOutdated: false, version: currentVersion } as const;
		}
		return {
			isOutdated: true,
			latestVersion,
			currentVersion,
			latestReleaseUrl,
		} as const;
	})();
</script>

<main class="flex w-full flex-1 flex-col pb-4 pt-2 px-4 mx-auto max-w-6xl">
	<div
		class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
	>
		<div class="space-y-0.5">
			<h2 class="text-2xl font-bold tracking-tight pl-[1.375rem] md:pl-0">
				Settings
			</h2>
			<p class="text-muted-foreground">
				{#await versionPromise}
					Customize your Whispering experience.
				{:then v}
					{#if v.isOutdated}
						{@const { latestVersion, currentVersion, latestReleaseUrl } = v}
						Customize your experience for Whispering {currentVersion} (latest
						<Link
							href={latestReleaseUrl}
							target="_blank"
							rel="noopener noreferrer"
						>
							{latestVersion}
						</Link>).
					{:else}
						{@const { version } = v}
						Customize your experience for Whispering {version}.
					{/if}
				{:catch error}
					Customize your Whispering experience.
				{/await}
			</p>
		</div>
		<Button
			variant="outline"
			size="sm"
			onclick={() => {
				confirmationDialog.open({
					title: 'Reset All Settings',
					subtitle:
						'This will reset all settings to their default values. This action cannot be undone.',
					confirmText: 'Reset Settings',
					onConfirm: () => {
						settings.reset();
						rpc.notify.success.execute({
							title: 'Settings reset',
							description: 'All settings have been reset to defaults.',
						});
					},
				});
			}}
			class="shrink-0"
		>
			<RotateCcw class="mr-2 size-4" />
			Reset to defaults
		</Button>
	</div>
	<Separator class="my-6" />
	<div
		class={sidebar.state === 'collapsed'
			? 'flex flex-col space-y-8 lg:flex-row lg:gap-8'
			: 'flex flex-col space-y-8 xl:flex-row xl:gap-8'}
	>
		<aside class={sidebar.state === 'collapsed' ? 'lg:w-1/6' : 'xl:w-1/6'}>
			<SidebarNav />
		</aside>
		<main
			class={sidebar.state === 'collapsed'
				? 'flex-1 lg:max-w-3xl'
				: 'flex-1 xl:max-w-3xl'}
		>
			{@render children()}
		</main>
	</div>
</main>
