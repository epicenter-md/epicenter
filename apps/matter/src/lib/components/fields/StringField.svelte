<script lang="ts">
	import TextCell from './TextCell.svelte';
	import type { FieldProps } from './field-props';

	// The widget floor: a plain text input over the raw string, saved verbatim.
	// `string` is the always-valid base kind, so the draft never fails to parse, and
	// an empty input is the legal empty string `""` (a present value), not a clear:
	// deleting the key is the cell's chrome. A `minLength` field rejects `""` as
	// INVALID, the same way it does for any too-short value.
	let { cell, save }: FieldProps = $props();
</script>

<TextCell {cell} {save} parse={(text) => ({ type: 'value', value: text })} />
