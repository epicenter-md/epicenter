<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import EraserIcon from '@lucide/svelte/icons/eraser';
	import type { Cell } from '$lib/core/conformance';
	import { FIELD_COMPONENTS } from './fields/registry';
	import type { SaveField } from './fields/field-props';
	import JsonRepairEditor from './JsonRepairEditor.svelte';

	let {
		cell,
		save,
		clear,
		mode = 'grid',
	}: {
		cell: Cell;
		save: SaveField;
		/** Delete the field's key (back to NEEDS_VALUE), never write `null`. */
		clear: () => void;
		/**
		 * Presentation mode. `grid` is the dense spreadsheet cell: scanning comes
		 * first, so the clear affordance stays quiet (dimmed) at rest and brightens on
		 * hover or keyboard focus. `detail` is the editing row in the row dialog:
		 * editing comes first, so the clear affordance is shown at full strength.
		 * Defaults to the quieter `grid`.
		 */
		mode?: 'grid' | 'detail';
	} = $props();

	// Kind dispatch is gated behind VALIDITY: an INVALID value is out of every
	// widget's domain, so it goes to the universal JSON repair editor; an OK or
	// empty value goes to the typed field widget for its kind. The widget never sees
	// an INVALID value, which is why no widget handles that state.
	const FieldComponent = $derived(FIELD_COMPONENTS[cell.field.kind]);

	// One clear control for every kind, owned here instead of reinvented per widget
	// (a blank text input, a Select item, removing the last chip, nothing at all).
	// It deletes the field's key, so it only makes sense when a value exists: shown
	// for OK and INVALID, never for an already-empty NEEDS_VALUE cell. The widgets
	// now only ever COMMIT a value in their kind's domain; clearing lives here.
	const clearable = $derived(cell.state !== 'NEEDS_VALUE');

	// In the grid an OK cell keeps the eraser QUIET (dimmed) at rest so the table
	// reads as a validation spreadsheet, then brightens it on hover or keyboard
	// focus. It stays PRESENT, never opacity-hidden: an invisible button is still in
	// the tab order and the a11y tree, so hiding it visually buys assistive tech
	// nothing and only costs sighted discoverability and touch. An INVALID grid cell
	// shows it at full strength because clearing is the repair path out of an
	// out-of-domain value, and the detail dialog shows it full because that surface
	// optimizes for editing, not scanning.
	const quietAtRest = $derived(mode === 'grid' && cell.state === 'OK');
</script>

{#snippet eraser()}
	<!-- Clearing a field is its own verb, distinct from the dialog-close X and the
	     tag-chip-removal X: an eraser wipes one field's value. It deletes the key
	     (back to NEEDS_VALUE) and never writes null. -->
	<Button
		variant="ghost"
		size={mode === 'detail' ? 'icon-sm' : 'icon-xs'}
		onclick={clear}
		aria-label="Clear {cell.field.name}"
		tooltip="Clear {cell.field.name}"
		class={[
			'shrink-0 text-muted-foreground transition-opacity hover:text-foreground',
			quietAtRest &&
				'opacity-40 focus-visible:opacity-100 group-hover/cell:opacity-100 group-focus-within/cell:opacity-100',
		]}
	>
		<EraserIcon />
	</Button>
{/snippet}

<div class={['group/cell flex items-center', mode === 'detail' ? 'gap-2' : 'gap-1']}>
	<div class="min-w-0 flex-1">
		{#if cell.state === 'INVALID'}
			<JsonRepairEditor {cell} {save} />
		{:else}
			<FieldComponent {cell} {save} />
		{/if}
	</div>
	{#if mode === 'grid'}
		<!-- A fixed trailing slot, reserved for every cell (even an empty NEEDS_VALUE
		     one with no eraser) so the content column never reflows between states or
		     when the eraser fades in. Opacity, not conditional layout, hides it. -->
		<div class="flex size-6 shrink-0 items-center justify-center">
			{#if clearable}{@render eraser()}{/if}
		</div>
	{:else if clearable}
		{@render eraser()}
	{/if}
</div>
