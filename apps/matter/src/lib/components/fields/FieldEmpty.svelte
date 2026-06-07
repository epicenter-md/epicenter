<script lang="ts">
	// The shared empty-cell indicator, rendered by every Field's empty branch. With
	// everything-required, an empty modeled cell is always NEEDS_VALUE (an absent key
	// or explicit null on a required field), so this is unconditionally the "needs a
	// value" hint. No state prop: dispatch gates INVALID elsewhere and OK shows a
	// value, so the only state a Field's empty branch sees is NEEDS_VALUE.
	//
	// The CELL already carries the amber ring + tint (FolderGrid's cellStateClass), so
	// this is plain coloured text, not a second boxed badge stacked inside that ring:
	// one quiet label per empty cell instead of a wall of outlined pills on a sparse row.
</script>

<span class="text-xs font-medium text-amber-700 dark:text-amber-500">required</span>
