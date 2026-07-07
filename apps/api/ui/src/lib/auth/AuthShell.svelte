<!--
	Two-pane shell for the sign-in surface: a brand panel carrying identity and
	the local-first promise, and a pane carrying the auth action.

	On small screens the brand panel dissolves (`contents`): the lockup stays on
	top so the page is recognizably Epicenter, the auth pane follows so the
	primary action is visible without scrolling, and the explanation re-orders
	below it.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import EpicenterMark from './EpicenterMark.svelte';

	let { children }: { children: Snippet } = $props();

	const proofs = [
		'Local-first by default',
		'Sync when you choose',
		'Self-hosting stays separate',
	];
</script>

<div class="flex min-h-dvh flex-col lg:grid lg:grid-cols-2">
	<aside
		class="contents lg:flex lg:flex-col lg:gap-12 lg:border-r lg:bg-muted/30 lg:p-12"
	>
		<div class="order-first flex items-center gap-3 p-6 lg:order-none lg:p-0">
			<EpicenterMark class="size-8 rounded-lg" />
			<span class="text-lg font-semibold tracking-tight">epicenter</span>
		</div>
		<div
			class="order-last flex max-w-md flex-col gap-4 p-6 lg:order-none lg:my-auto lg:p-0"
		>
			<h2 class="text-2xl font-semibold tracking-tight">
				Your workspace stays yours.
			</h2>
			<p class="text-sm text-muted-foreground">
				Sign in adds sync, backups, and hosted AI credits. Your local workspace
				still opens without an account.
			</p>
			<ul class="flex flex-col gap-2 text-sm text-muted-foreground">
				{#each proofs as proof (proof)}
					<li class="flex items-center gap-2">
						<CircleCheckIcon class="size-4 shrink-0" aria-hidden="true" />
						{proof}
					</li>
				{/each}
			</ul>
		</div>
	</aside>
	<main class="flex flex-1 items-center justify-center p-6 lg:p-12">
		{@render children()}
	</main>
</div>
