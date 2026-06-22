<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import DevAccessibilityToggle from '$lib/components/DevAccessibilityToggle.svelte';
	import MacosAccessibilityGuideDialog from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import MoreDetailsDialog from '$lib/components/MoreDetailsDialog.svelte';
	import RecipePicker from '$lib/components/RecipePicker.svelte';
	import UpdateDialog from '$lib/components/UpdateDialog.svelte';
</script>

<!--
	App-wide singleton dialogs. Each is driven by a module-level store, so this
	component mounts them once for the whole app. It lives at the session root,
	outside the responsive nav branch, so resizing across the breakpoint never
	tears a dialog down mid-interaction.
-->
<ConfirmationDialog />
<MacosAccessibilityGuideDialog />
<MoreDetailsDialog />
<RecipePicker />
<UpdateDialog />

{#if import.meta.env.DEV}
	<DevAccessibilityToggle />
{/if}
