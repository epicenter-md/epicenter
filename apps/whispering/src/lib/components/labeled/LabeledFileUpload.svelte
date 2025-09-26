<script lang="ts">
	import { Button } from '@repo/ui/button';
	import { Label } from '@repo/ui/label';
	import { UploadIcon, PlayIcon, RepeatIcon } from '@lucide/svelte';

	interface Props {
		id: string;
		label: string;
		currentFile?: string;
		onFileChange: (file: File | null) => void;
		onTest?: () => void;
		onReset?: () => void;
		accept?: string;
		description?: string;
	}

	let {
		id,
		label,
		currentFile = '',
		onFileChange,
		onTest,
		onReset,
		accept = 'audio/*',
		description,
	}: Props = $props();

	let fileInput: HTMLInputElement;

	const handleFileChange = (event: Event) => {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0] || null;
		onFileChange(file);
	};

	const triggerFileSelect = () => {
		fileInput?.click();
	};

	const hasCustomFile = $derived(currentFile && currentFile.length > 0);
	const fileName = $derived(currentFile ? currentFile.split('/').pop() || currentFile : '');
</script>

<div class="space-y-2">
	<Label for={id}>{label}</Label>
	
	<div class="flex items-center gap-2">
		<input
			bind:this={fileInput}
			{id}
			type="file"
			{accept}
			onchange={handleFileChange}
			class="hidden"
		/>
		
		<Button 
			variant="outline" 
			size="sm" 
			onclick={triggerFileSelect}
			class="flex-1"
		>
			<UploadIcon class="mr-2 size-4" />
			{hasCustomFile ? 'Change' : 'Upload'} Sound
		</Button>
		
		{#if onTest}
			<Button variant="outline" size="sm" onclick={onTest}>
				<PlayIcon class="mr-2 size-4" />
				Test
			</Button>
		{/if}
		
		{#if hasCustomFile && onReset}
			<Button variant="outline" size="sm" onclick={onReset}>
				<RepeatIcon class="mr-2 size-4" />
				Reset
			</Button>
		{/if}
	</div>
	
	{#if hasCustomFile}
		<p class="text-sm text-muted-foreground">
			Custom: {fileName}
		</p>
	{:else}
		<p class="text-sm text-muted-foreground">
			Using default sound
		</p>
	{/if}
	
	{#if description}
		<p class="text-sm text-muted-foreground">{description}</p>
	{/if}
</div>
