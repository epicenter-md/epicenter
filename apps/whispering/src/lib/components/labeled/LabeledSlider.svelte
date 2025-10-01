<script lang="ts">
	import { Label } from '@repo/ui/label';

	interface Props {
		id: string;
		label: string;
		value: number;
		min?: number;
		max?: number;
		step?: number;
		onValueChange?: (value: number) => void;
		description?: string;
	}

	let {
		id,
		label,
		value = $bindable(),
		min = 0,
		max = 100,
		step = 1,
		onValueChange,
		description,
	}: Props = $props();

	const handleInput = (event: Event) => {
		const target = event.target as HTMLInputElement;
		const newValue = Number(target.value);
		value = newValue;
		onValueChange?.(newValue);
	};

	// Calculate percentage for visual fill
	const percentage = $derived(((value - min) / (max - min)) * 100);
</script>

<div class="grid w-full max-w-sm items-center gap-1.5">
	<Label for={id}>{label}</Label>
	<div class="flex items-center gap-3">
		<span class="text-sm text-muted-foreground">{min}</span>
		<div class="flex-1 relative">
			<!-- Background track -->
			<div class="relative h-2 bg-secondary rounded-full">
				<!-- Progress fill -->
				<div 
					class="absolute top-0 left-0 h-full bg-primary rounded-full transition-all duration-150"
					style="width: {percentage}%"
				></div>
				<!-- Range input -->
				<input
					{id}
					type="range"
					{min}
					{max}
					{step}
					{value}
					oninput={handleInput}
					class="absolute top-0 left-0 w-full h-full opacity-0 cursor-pointer"
				/>
				<!-- Custom thumb -->
				<div 
					class="absolute top-1/2 w-5 h-5 bg-primary border-2 border-background rounded-full shadow-sm transform -translate-y-1/2 -translate-x-1/2 transition-all duration-150 hover:scale-110 cursor-pointer"
					style="left: {percentage}%"
				></div>
			</div>
		</div>
		<span class="text-sm text-muted-foreground">{max}</span>
		<span class="text-sm font-medium min-w-8 text-center">{value}{min === 0 && max === 100 ? '%' : ''}</span>
	</div>
	{#if description}
		<p class="text-sm text-muted-foreground">{description}</p>
	{/if}
</div>
