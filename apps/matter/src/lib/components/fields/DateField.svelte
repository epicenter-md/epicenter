<script lang="ts">
	import TextCell from './TextCell.svelte';
	import type { FieldOf } from '@epicenter/matter-core/field';
	import type { FieldProps } from './field-props';

	// Calendar dates are edited as ISO text for now. The schema validator keeps this
	// to `YYYY-MM-DD`; a real date picker can replace this shell later.
	let { cell, save }: FieldProps<FieldOf<'date'>> = $props();
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
