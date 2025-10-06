<script lang="ts">
	import * as Card from '@repo/ui/card';
	import { cn } from '@repo/ui/utils';

	type Principle = {
		title: string;
		description: string;
		icon?: string;
	};

	const userPrinciples: Principle[] = [
		{
			title: 'Own your data',
			description:
				'Everything lives as files on your disk. Delete the app, keep your work.',
		},
		{
			title: 'Use any model',
			description: 'OpenAI, Anthropic, local LLMs. Your choice, your API key.',
		},
		{
			title: 'Preserve authenticity',
			description: 'No middleman. Direct connection to your tools and models.',
		},
	];

	const developerPrinciples: Principle[] = [
		{
			title: 'Free and open source',
			description: 'Audit the code. Fork it. Make it yours.',
		},
		{
			title: 'Blazing fast',
			description:
				'Built with Rust, Svelte 5, and obsessive performance optimization.',
		},
		{
			title: "Built on tomorrow's stack",
			description:
				'CRDTs, local-first architecture, and the bleeding edge of web tech.',
		},
	];

	type Props = {
		class?: string;
	};

	let { class: className }: Props = $props();
</script>

<section class={cn('grid md:grid-cols-2 gap-12', className)}>
	<div>
		<h3 class="text-lg font-semibold text-foreground mb-6">For You</h3>
		<div class="space-y-4">
			{#each userPrinciples as principle}
				<Card.Root class="hover:shadow-md transition-shadow">
					<Card.Content>
						<Card.Title class="text-base mb-2">{principle.title}</Card.Title>
						<Card.Description class="text-sm"
							>{principle.description}</Card.Description
						>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	</div>
	<div>
		<h3 class="text-lg font-semibold text-foreground mb-6">For Developers</h3>
		<div class="space-y-4">
			{#each developerPrinciples as principle}
				<Card.Root class="hover:shadow-md transition-shadow">
					<Card.Content>
						<Card.Title class="text-base mb-2">{principle.title}</Card.Title>
						<Card.Description class="text-sm"
							>{principle.description}</Card.Description
						>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	</div>
</section>
