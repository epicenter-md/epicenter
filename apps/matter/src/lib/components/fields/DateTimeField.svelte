<script lang="ts">
	import TextCell from './TextCell.svelte';
	import type { FieldProps } from './field-props';

	// A text input over the RFC 3339 string for now; a NaturalLanguageDateInput
	// picker lands with the calendar view (spec "Later"). A value that is not valid
	// RFC 3339 classifies INVALID and routes to the JSON repair editor, so this only
	// ever sees a parseable instant. An empty draft reverts: there is no empty
	// instant, and clearing the key is the cell's chrome. The distinct kind is the
	// seam where the picker replaces this one prop.
	let { cell, save }: FieldProps = $props();
</script>

<TextCell
	{cell}
	{save}
	displayClass="tabular-nums"
	parse={(text) =>
		text.trim() === '' ? { type: 'cancel' } : { type: 'value', value: text }}
/>
