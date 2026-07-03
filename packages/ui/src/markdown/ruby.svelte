<!--
	One romanizer segment. A segment with a reading becomes a native <ruby> (with
	<rp> parens as the fallback for browsers without ruby support, and for clean
	copy/paste); one without passes its text through. Real DOM nodes, never an
	HTML string, so nothing needs sanitizing.

	The whole thing is one line so no template whitespace lands between adjacent
	segments, which would split CJK runs (你好 must not render as 你 好).
-->
<script lang="ts">
	import type { Segment } from './romanizer.js';

	let {
		segment,
	}: {
		segment: Segment;
	} = $props();
</script>

{#if segment.reading}<ruby>{segment.text}<rp>(</rp><rt>{segment.reading}</rt><rp>)</rp></ruby>{:else}{segment.text}{/if}
