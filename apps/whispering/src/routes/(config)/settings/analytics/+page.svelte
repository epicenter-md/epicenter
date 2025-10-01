<script lang="ts">
	import * as Card from '@repo/ui/card';
	import { Badge } from '@repo/ui/badge';
	import { Label } from '@repo/ui/label';
	import { Switch } from '@repo/ui/switch';
	import { rpc } from '$lib/query';
	import { settings } from '$lib/stores/settings.svelte';

</script>

<div class="space-y-8">
	<!-- Page Header -->
	<div class="space-y-2">
		<div class="flex items-center gap-3">
			<h3 class="text-xl font-semibold tracking-tight">Analytics</h3>
			{#if settings.value['analytics.enabled']}
				<Badge variant="outline" class="text-xs text-green-700 dark:text-green-400 border-green-200 dark:border-green-400/30">
					Enabled
				</Badge>
			{:else}
				<Badge variant="outline" class="text-xs text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-400/30">
					Disabled
				</Badge>
			{/if}
		</div>
		<p class="text-sm text-muted-foreground max-w-2xl">
			Help us understand which features are used most. We use anonymized event logging to improve Whispering.
		</p>
	</div>

	<!-- Main Toggle Section -->
	<Card.Root class="transition-colors duration-200">
		<Card.Content>
			<div class="flex items-start justify-between gap-4">
				<div class="space-y-2 flex-1">
					<Label for="analytics-toggle" class="text-base font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
						Share anonymized events
					</Label>
					<p class="text-sm text-muted-foreground leading-relaxed">
						We log simple events like "recording started" or "transcription completed". No personal data is attached to any of these events.
					</p>
				</div>
				<Switch
					id="analytics-toggle"
					bind:checked={
						() => settings.value['analytics.enabled'],
						(checked) => {
							settings.updateKey('analytics.enabled', checked);
							
							// Log the change (will only send if analytics is now enabled)
							if (checked) {
								rpc.analytics.logEvent.execute({ type: 'settings_changed', section: 'analytics' });
							}
						}
					}
					class="shrink-0"
				/>
			</div>
		</Card.Content>
	</Card.Root>

	<!-- Data Collection Information -->
	<div class="grid gap-4 md:grid-cols-2">
		<Card.Root class="border-green-100 dark:border-green-900/20">
			<Card.Header>
				<Card.Title class="text-sm font-medium text-green-700 dark:text-green-400 flex items-center gap-2">
					<div class="w-2 h-2 bg-green-500 rounded-full"></div>
					Events we log
				</Card.Title>
			</Card.Header>
			<Card.Content>
				<ul class="text-sm text-muted-foreground space-y-1.5 leading-relaxed">
					<li class="flex items-start gap-2">
						<span class="text-green-500 mt-1">•</span>
						<span>Button clicks (which features you use)</span>
					</li>
					<li class="flex items-start gap-2">
						<span class="text-green-500 mt-1">•</span>
						<span>Completion times (how long things take)</span>
					</li>
					<li class="flex items-start gap-2">
						<span class="text-green-500 mt-1">•</span>
						<span>Error messages (when something fails)</span>
					</li>
				</ul>
			</Card.Content>
		</Card.Root>

		<Card.Root class="border-amber-100 dark:border-amber-900/20">
			<Card.Header>
				<Card.Title class="text-sm font-medium text-amber-700 dark:text-amber-400 flex items-center gap-2">
					<div class="w-2 h-2 bg-amber-500 rounded-full"></div>
					Never collected
				</Card.Title>
			</Card.Header>
			<Card.Content>
				<ul class="text-sm text-muted-foreground space-y-1.5 leading-relaxed">
					<li class="flex items-start gap-2">
						<span class="text-amber-500 mt-1">•</span>
						<span>Your actual transcriptions or recordings</span>
					</li>
					<li class="flex items-start gap-2">
						<span class="text-amber-500 mt-1">•</span>
						<span>Device IDs or user identifiers</span>
					</li>
					<li class="flex items-start gap-2">
						<span class="text-amber-500 mt-1">•</span>
						<span>API keys or any personal data</span>
					</li>
				</ul>
			</Card.Content>
		</Card.Root>
	</div>

	<!-- Transparency Section -->
	<Card.Root class="bg-muted/30 border-dashed">
		<Card.Header>
			<Card.Title class="text-base font-medium">Full Transparency</Card.Title>
			<Card.Description>
				All analytics code is open source and auditable. See exactly what data is collected and when.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-3">
			<div class="grid gap-2 text-sm">
				<a
					href="https://github.com/epicenter-so/epicenter/tree/main/apps/whispering/src/lib/services/analytics.ts"
					target="_blank"
					rel="noopener noreferrer"
					class="group flex items-center gap-2 text-primary hover:text-primary/80 transition-colors"
				>
					<span class="text-muted-foreground group-hover:text-primary/60 transition-colors">→</span>
					<span class="underline underline-offset-4 decoration-transparent group-hover:decoration-current transition-colors">View event definitions</span>
				</a>
				<a
					href="https://github.com/search?q=repo%3Aepicenter-so%2Fepicenter+rpc.analytics.logEvent&type=code"
					target="_blank"
					rel="noopener noreferrer"
					class="group flex items-center gap-2 text-primary hover:text-primary/80 transition-colors"
				>
					<span class="text-muted-foreground group-hover:text-primary/60 transition-colors">→</span>
					<span class="underline underline-offset-4 decoration-transparent group-hover:decoration-current transition-colors">See where events are logged</span>
				</a>
				<a
					href="https://github.com/aptabase"
					target="_blank"
					rel="noopener noreferrer"
					class="group flex items-center gap-2 text-primary hover:text-primary/80 transition-colors"
				>
					<span class="text-muted-foreground group-hover:text-primary/60 transition-colors">→</span>
					<span class="underline underline-offset-4 decoration-transparent group-hover:decoration-current transition-colors">Learn about Aptabase</span>
				</a>
			</div>
		</Card.Content>
	</Card.Root>

	<!-- Status Footer -->
	<div class="flex items-center gap-2 text-xs">
		{#if settings.value['analytics.enabled']}
			<div class="flex items-center gap-2 text-green-700 dark:text-green-400">
				<div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
				<span class="font-medium">Analytics active</span>
				<span class="text-muted-foreground">• Changes take effect immediately</span>
			</div>
		{:else}
			<div class="flex items-center gap-2 text-amber-700 dark:text-amber-400">
				<div class="w-2 h-2 bg-amber-500 rounded-full"></div>
				<span class="font-medium">Analytics disabled</span>
				<span class="text-muted-foreground">• No data is being collected</span>
			</div>
		{/if}
	</div>
</div>