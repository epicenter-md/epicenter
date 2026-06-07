<script lang="ts">
	import { Checkbox } from '@epicenter/ui/checkbox';
	import type { FieldProps } from './field-props';

	// A checkbox, not a Select: with everything-required a boolean is exactly true or
	// false, plus the "not filled in yet" state, and a checkbox shows all three
	// without a popover. checked = true, empty box = false, the minus (indeterminate)
	// = NEEDS_VALUE. Clicking an indeterminate box sets it true (bits-ui), which fills
	// the cell; the grid rings NEEDS_VALUE until then.
	//
	// The committed value is a real boolean primitive, never a string or 0/1: the
	// `{type:'boolean'}` schema validates only JS booleans, so anything else would
	// flip the cell to INVALID (and route to the repair editor). bits-ui hands
	// onCheckedChange a boolean, so the save is direct. Toggling only ever moves
	// between true and false; emptying the cell back to NEEDS_VALUE is the shared
	// cell chrome (the same control every kind gets), not a gesture on the checkbox.
	let { cell, save }: FieldProps = $props();

	// Read the classifier's verdict, not a re-derived nullish check: conformance
	// already collapsed "absent key OR bare YAML null" into NEEDS_VALUE (the one
	// place the empty contract lives), so the widget asks `state`, not `value == null`.
	// `checked` is the only thing that needs the value itself, and only an exact
	// boolean true checks the box (an OK boolean cell is true or false).
	const checked = $derived(cell.state === 'OK' && cell.value === true);
	const indeterminate = $derived(cell.state === 'NEEDS_VALUE');
</script>

<Checkbox
	{checked}
	{indeterminate}
	aria-label={cell.field.name}
	onCheckedChange={(value) => save(value)}
/>
