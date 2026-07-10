<script lang="ts">
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';

	// A VAD session's capture state, shown beside the pill's live meter as one
	// small mark: a dot that is dim while merely listening (armed, hearing sound
	// but not yet latched) and lights up the instant capture latches onto speech,
	// then becomes a spinner while a previous phrase is still transcribing. The
	// bars next to it track raw loudness; this mark tracks VAD's decision, which
	// lags loudness by a detection delay, so the two are deliberately separate
	// signals. The pill is the only surface that renders it, so the palette is
	// fixed here rather than passed in.
	//
	// `isSpeaking` and `isTranscribing` are orthogonal at the source; this mark shows
	// one of three states, so transcribing wins (the spinner replaces the dot).
	// That precedence lives here, the one place this mark is rendered.
	let {
		signals,
	}: {
		/**
		 * The two orthogonal VAD signals this mark renders: `isSpeaking` (latched
		 * onto speech, past mere loudness) and `isTranscribing` (a previous phrase
		 * still transcribing). They arrive as one object because the status projection
		 * produces them together; the pill also reads `isSpeaking` off the same
		 * object to tint its meter bars.
		 */
		signals: { isSpeaking: boolean; isTranscribing: boolean };
	} = $props();

	// One title for whichever state shows.
	const title = $derived(
		signals.isTranscribing
			? 'Transcribing previous phrase'
			: signals.isSpeaking
				? 'Capturing speech'
				: 'Listening',
	);
</script>

<span class="inline-flex items-center justify-center" {title} aria-hidden="true">
	{#if signals.isTranscribing}
		<Spinner class="size-3.5 text-white/50" />
	{:else}
		<span
			class={cn(
				'size-2 rounded-full transition-colors duration-150',
				signals.isSpeaking ? 'bg-pink-300' : 'bg-white/40',
			)}
		></span>
	{/if}
</span>
