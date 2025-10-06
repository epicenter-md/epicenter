<script lang="ts">
	import { Button } from '@repo/ui/button';
	import { Input } from '@repo/ui/input';
	import { Label } from '@repo/ui/label';
	import { Checkbox } from '@repo/ui/checkbox';
	import { cn } from '@repo/ui/utils';

	const interestOptions = [
		{ id: 'notes', label: 'Note-taking that connects everything' },
		{ id: 'tasks', label: 'Task management across projects' },
		{ id: 'email', label: 'Email client with full context' },
		{ id: 'research', label: 'Research assistant with memory' },
		{ id: 'writing', label: 'Writing environment that remembers' },
		{ id: 'crm', label: 'Personal CRM' },
		{ id: 'calendar', label: 'Calendar that understands context' },
	];

	type Props = {
		class?: string;
	};

	let { class: className }: Props = $props();
	let email = $state('');
	let interests = $state<string[]>([]);
	let otherInterest = $state('');
	let isSubmitting = $state(false);
	let submitted = $state(false);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		isSubmitting = true;

		try {
			const formData = new FormData();
			formData.append('email', email);
			interests.forEach((interest) => formData.append('interests', interest));
			if (otherInterest) {
				formData.append('otherInterest', otherInterest);
			}

			// TODO: Implement form submission
			// Simulating submission for now
			await new Promise((resolve) => setTimeout(resolve, 1000));
			submitted = true;
		} catch (error) {
			console.error('Error submitting form:', error);
		} finally {
			isSubmitting = false;
		}
	}

	function toggleInterest(
		optionId: string,
		checked: boolean | 'indeterminate',
	) {
		if (checked === true) {
			interests = [...interests, optionId];
		} else {
			interests = interests.filter((i) => i !== optionId);
		}
	}
</script>

{#if submitted}
	<div class={cn('text-center py-12', className)}>
		<h3 class="text-2xl font-semibold text-foreground mb-4">
			Thanks for joining!
		</h3>
		<p class="text-muted-foreground">
			We'll let you know when new tools are ready.
		</p>
	</div>
{:else}
	<form onsubmit={handleSubmit} class={cn('space-y-6', className)}>
		<div>
			<Label for="email">Email</Label>
			<Input
				id="email"
				type="email"
				bind:value={email}
				placeholder="you@example.com"
				required
				class="mt-1"
			/>
		</div>

		<div>
			<Label class="mb-3 block">What tools would help your workflow?</Label>
			<div class="space-y-3">
				{#each interestOptions as option}
					<div class="flex items-center space-x-2">
						<Checkbox
							id={option.id}
							bind:checked={
								() => interests.includes(option.id),
								(checked) => toggleInterest(option.id, checked)
							}
						/>
						<Label for={option.id} class="font-normal cursor-pointer">
							{option.label}
						</Label>
					</div>
				{/each}

				<div class="pt-2">
					<Label for="other" class="block mb-1">Other</Label>
					<Input
						id="other"
						type="text"
						bind:value={otherInterest}
						placeholder="Tell us what else you'd like to see"
						class="w-full"
					/>
				</div>
			</div>
		</div>

		<Button type="submit" disabled={isSubmitting} class="w-full">
			{isSubmitting ? 'Joining...' : 'Join the waitlist'}
		</Button>
	</form>
{/if}
