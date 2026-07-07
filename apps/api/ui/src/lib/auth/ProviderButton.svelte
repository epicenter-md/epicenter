<!--
	One "Continue with <provider>" button. Owns the brand icon and label per
	provider id so the sign-in page can render enabled providers from a loop.
	Brand icons stay inline SVG: Google and Microsoft use fixed brand colors,
	GitHub and Apple inherit the button text color via currentColor.

	The icon is absolutely positioned at a fixed left inset so stacked buttons
	form an aligned icon rail while each label stays centered.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import {
		PROVIDER_LABELS,
		type SocialProvider,
	} from './sign-in-context';

	let {
		provider,
		disabled = false,
		onclick,
	}: {
		provider: SocialProvider;
		disabled?: boolean;
		onclick: () => void;
	} = $props();
</script>

<Button variant="outline" class="relative h-11 w-full" {disabled} {onclick}>
	<span
		class="absolute left-4 flex size-4 items-center justify-center"
		aria-hidden="true"
	>
		{#if provider === 'google'}
			<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
				<path
					d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
					fill="#4285F4"
				/>
				<path
					d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
					fill="#34A853"
				/>
				<path
					d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
					fill="#FBBC05"
				/>
				<path
					d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
					fill="#EA4335"
				/>
			</svg>
		{:else if provider === 'github'}
			<svg
				width="16"
				height="16"
				viewBox="0 0 16 16"
				aria-hidden="true"
				fill="currentColor"
			>
				<path
					d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"
				/>
			</svg>
		{:else if provider === 'microsoft'}
			<svg width="16" height="16" viewBox="0 0 23 23" aria-hidden="true">
				<path fill="#F25022" d="M1 1h10v10H1z" />
				<path fill="#7FBA00" d="M12 1h10v10H12z" />
				<path fill="#00A4EF" d="M1 12h10v10H1z" />
				<path fill="#FFB900" d="M12 12h10v10H12z" />
			</svg>
		{:else if provider === 'apple'}
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				aria-hidden="true"
				fill="currentColor"
			>
				<path
					d="M17.05 12.53c-.02-2.02 1.65-2.99 1.72-3.04-.94-1.37-2.4-1.56-2.92-1.58-1.24-.13-2.42.73-3.05.73-.63 0-1.6-.71-2.63-.69-1.35.02-2.6.79-3.3 2-1.4 2.44-.36 6.05 1 8.03.67.97 1.47 2.06 2.5 2.02 1-.04 1.38-.65 2.6-.65 1.2 0 1.55.65 2.6.63 1.08-.02 1.76-.99 2.42-1.96.76-1.12 1.07-2.2 1.09-2.26-.02-.01-2.09-.8-2.11-3.18zM15.1 6.3c.55-.67.92-1.6.82-2.53-.79.03-1.76.53-2.33 1.19-.51.59-.96 1.54-.84 2.44.88.07 1.79-.44 2.35-1.1z"
				/>
			</svg>
		{/if}
	</span>
	Continue with {PROVIDER_LABELS[provider]}
</Button>
