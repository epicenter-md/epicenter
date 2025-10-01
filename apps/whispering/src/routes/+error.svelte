<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>
		{page.status === 404 ? 'Page Not Found' : 'Error'} - Whispering
	</title>
</svelte:head>

<main class="flex flex-1 flex-col items-center justify-center gap-6 p-8">
	<div class="text-center space-y-6">
		<h1 class="text-4xl font-bold text-foreground">
			{#if page.status === 404}
				404 - Page Not Found
			{:else}
				Something Went Wrong
			{/if}
		</h1>

		<p class="text-muted-foreground text-lg">
			{#if page.status === 404}
				The page you're looking for doesn't exist.
			{:else}
				An unexpected error occurred.
			{/if}
		</p>

		<div class="pt-4">
			<a 
				href="/"
				class="inline-flex items-center justify-center rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 transition-colors"
			>
				Go Home
			</a>
		</div>
	</div>
</main>
