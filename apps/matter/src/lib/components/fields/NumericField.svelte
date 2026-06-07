<script lang="ts">
	import TextCell from './TextCell.svelte';
	import type { FieldProps } from './field-props';

	// Serves BOTH `number` and `integer`: parsing is identical (Number()), and the
	// integer-vs-float distinction is the SCHEMA's to enforce. A non-finite draft is
	// kept as the raw string so it persists as INVALID to fix, never silently dropped
	// (the model never gates a write); an integer field given 3.5 likewise classifies
	// INVALID and routes to the JSON repair editor on its next edit. An empty draft
	// reverts: there is no empty number, and clearing the key is the cell's chrome.
	let { cell, save }: FieldProps = $props();
</script>

<TextCell
	{cell}
	{save}
	inputClass="tabular-nums"
	displayClass="tabular-nums"
	inputmode="decimal"
	parse={(text) => {
		if (text.trim() === '') return { type: 'cancel' };
		const n = Number(text);
		return { type: 'value', value: Number.isFinite(n) ? n : text };
	}}
/>
