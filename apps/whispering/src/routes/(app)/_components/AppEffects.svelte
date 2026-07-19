<script lang="ts">
	import { installRecordingOverlay } from '#platform/recording-overlay';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import { exposeDebugCommands } from '../_app-effects/expose-debug-commands';
	import { listenForLocalShortcuts } from '../_app-effects/listen-for-local-shortcuts';
	import { logAppStarted } from '../_app-effects/log-app-started';
	import { notifyDictationFailures } from '../_app-effects/notify-dictation-failures.svelte';
	import { synchronizeAutoPasteIntent } from '../_app-effects/synchronize-auto-paste-intent.svelte';
	import { synchronizeShortcuts } from '../_app-effects/synchronize-shortcuts';
	import { synchronizeUnloadPolicy } from '../_app-effects/synchronize-unload-policy.svelte';

	// Headless component: mounts Whispering's page-lifetime listeners and
	// reactive projections once, at the session root outside the responsive nav
	// branch, so crossing a layout breakpoint never re-runs any of them. Each
	// helper registers its own lifecycle with Svelte; any required teardown is
	// scoped to this component through $effect cleanup or onMount unmount.
	exposeDebugCommands();
	logAppStarted();
	listenForLocalShortcuts();
	synchronizeShortcuts();
	installRecordingOverlay?.();
	notifyDictationFailures();
	synchronizeUnloadPolicy();
	synchronizeAutoPasteIntent();
	dictationCapability.track();
</script>
