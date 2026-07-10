<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';

	// Dev-only affordance (rendered behind `import.meta.env.DEV` in GlobalDialogs):
	// cycle the capability override so the notice and guide can be tested on any
	// build, including web dev where the value is otherwise always `unknown`. The
	// cycle (untrusted, active, broken, live) lives in the state
	// module; this button just advances it. `null` resumes the live value.
	const current = $derived(dictationCapability.override);
</script>

<!-- Bottom-right and faint-until-hover so it clears the left sidebar and the
mobile bottom nav (h-14); raised above that nav on narrow viewports. z above
dialogs so the override can be toggled while the guide dialog is open. The
cycling label is self-documenting, so no tooltip box to collide with content. -->
<Button
	variant="outline"
	size="sm"
	class="fixed right-3 bottom-3 z-[60] max-md:bottom-[4.75rem] font-mono text-xs opacity-40 hover:opacity-100"
	onclick={() => dictationCapability.cycleOverride()}
>
	AX: {current ?? 'live'}
</Button>
