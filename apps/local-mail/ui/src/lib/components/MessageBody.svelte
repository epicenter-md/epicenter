<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { sanitizeEmailHtml } from '$lib/sanitize-email';

	let {
		unsafeHtml,
		text,
		externalized = false,
	}: {
		/** The raw `text/html` body from the read model, unsanitized. This
		 * component is the only place it may render: it passes through
		 * `sanitizeEmailHtml` before the single `{@html}` sink below. */
		unsafeHtml: string | null;
		/** The extracted plain-text body, the fallback and the "Plain text" view. */
		text: string | null;
		/** Whether Gmail holds this message's body as an attachment rather than
		 * inline, so there is no offline copy to show. It changes only what the
		 * empty state says; there is nothing to fetch and no state to advance. */
		externalized?: boolean;
	} = $props();

	// Sanitize once per body. This derived value is the ONLY string in the app
	// allowed to reach `{@html}`; email HTML is hostile, so it never renders raw.
	const safeHtml = $derived(unsafeHtml ? sanitizeEmailHtml(unsafeHtml) : null);

	// A per-message view choice, local state only, not a persisted preference.
	// The shown view is the user's pick if they made one, else the natural
	// default: the formatted body when the message has one, plain text otherwise.
	// The parent remounts this per message via `{#key}`, so the choice resets.
	let userView = $state<'formatted' | 'plain' | null>(null);
	const view = $derived(userView ?? (safeHtml ? 'formatted' : 'plain'));

	// The toggle only earns its place when both views exist; with only one body
	// there is nothing to switch to. Formatted is primary and plain text is the
	// escape hatch, so this is one secondary button, not a segmented control.
	const canToggle = $derived(safeHtml !== null && text !== null);
</script>

<div class="flex min-h-0 flex-1 flex-col">
	{#if canToggle}
		<div class="flex shrink-0 justify-end px-5 pt-3">
			<Button
				variant="ghost"
				size="sm"
				class="text-xs text-muted-foreground"
				onclick={() => (userView = view === 'formatted' ? 'plain' : 'formatted')}
			>
				{view === 'formatted' ? 'View as plain text' : 'View formatted'}
			</Button>
		</div>
	{/if}

	<div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-4">
		{#if safeHtml && view === 'formatted'}
			<!-- A formatted email is a foreign document that assumes a light canvas,
			     so it renders on its own bounded white sheet rather than inheriting
			     the app's dark theme. `color-scheme: light` keeps inherited/default
			     colors readable; the sanitizer already stripped remote assets. -->
			<div
				class="email-canvas mx-auto box-border w-full max-w-[640px] overflow-hidden rounded-lg border border-border bg-white px-6 py-5 text-neutral-900 [color-scheme:light]"
			>
				<!-- The single `{@html}` site in the app. `safeHtml` is DOMPurify
				     output; remote assets are stripped and links open in a new tab. -->
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				{@html safeHtml}
			</div>
		{:else if text}
			<pre class="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground/90">{text}</pre>
		{:else if externalized}
			<!-- Named, not papered over: Gmail returned this body as an attachment
			     reference instead of inline bytes, and one full message fetch is the
			     whole per-message budget, so it was never downloaded. The message is
			     fully synced; only the body lives elsewhere. -->
			<p class="text-sm text-muted-foreground">
				Gmail stores this message's body as an attachment, so there is no offline
				copy. Everything else about the message is here. Open it in Gmail to read
				the body.
			</p>
		{:else}
			<p class="text-sm italic text-muted-foreground">
				No readable body for this message.
			</p>
		{/if}
	</div>
</div>

<style>
	/* Keep hostile email markup inside its lane: cap media/table width so a wide
	   layout cannot force the sheet (or the app) to scroll horizontally. Not
	   fidelity styling, just containment. */
	.email-canvas {
		overflow-wrap: anywhere;
	}
	.email-canvas :global(*) {
		box-sizing: border-box;
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	.email-canvas :global(img),
	.email-canvas :global(table) {
		max-width: 100%;
	}
	.email-canvas :global(img) {
		height: auto;
	}
	.email-canvas :global(table) {
		table-layout: fixed;
		width: 100% !important;
	}
	.email-canvas :global(td),
	.email-canvas :global(th) {
		overflow-wrap: anywhere;
	}
	.email-canvas :global(a) {
		text-decoration: underline;
	}
</style>
