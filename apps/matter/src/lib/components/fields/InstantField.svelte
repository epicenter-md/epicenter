<script lang="ts">
	import TextCell from './TextCell.svelte';
	import type { FieldOf } from '@epicenter/matter-core/field';
	import type { FieldProps } from './field-props';

	// Canonical instants are edited as ISO text for now. The field schema enforces
	// fixed millisecond UTC form so text ordering stays chronological.
	let { cell, save }: FieldProps<FieldOf<'instant'>> = $props();
</script>

<TextCell
	{cell}
	{save}
	inputClass="tabular-nums"
	displayClass="tabular-nums"
	parse={(text) => {
		const value = text.trim();
		return value === '' ? { type: 'cancel' } : { type: 'value', value };
	}}
/>
