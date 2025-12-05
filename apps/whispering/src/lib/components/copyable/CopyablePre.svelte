<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';

	export const copyableVariants = tv({
		base: 'relative whitespace-normal rounded p-4 pr-12 text-sm',
		variants: {
			variant: {
				code: 'bg-muted font-mono',
				text: 'bg-muted text-muted-foreground',
				error: 'bg-destructive/10 text-destructive',
			},
		},
	});

	export type CopyableVariants = VariantProps<
		typeof copyableVariants
	>['variant'];
</script>

<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import { ClipboardIcon } from '$lib/components/icons';
	import CopyToClipboardButton from './CopyToClipboardButton.svelte';

	const {
		copyableText,
		variant,
		class: className,
	}: {
		copyableText: string;
		variant: CopyableVariants;
		class?: string;
	} = $props();
</script>

<pre class={cn(copyableVariants({ variant }), className)}>
{copyableText}
	<CopyToClipboardButton
		class="absolute right-4 top-1/2 -translate-y-1/2"
		contentDescription={variant === 'code' ? 'code' : 'transcript'}
		textToCopy={copyableText}>
		<ClipboardIcon class="size-4" />
	</CopyToClipboardButton>
</pre>
