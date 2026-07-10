<script lang="ts">
	import { dictationCapability } from '#dictation-capability';
	import { attachAutoPasteIntent } from '../../routes/(app)/_runtime/attach-auto-paste-intent.svelte';
	import { attachShortcutSync } from '../../routes/(app)/_runtime/attach-shortcut-sync';
	import { attachUnloadPolicy } from '../../routes/(app)/_runtime/attach-unload-policy.svelte';
	import { commonRuntimeOwners } from './common-owners';
	import RuntimeOwners from './RuntimeOwners.svelte';

	const epicenterRuntimeOwners = [
		...commonRuntimeOwners,
		attachShortcutSync,
		attachUnloadPolicy,
		attachAutoPasteIntent,
		dictationCapability.attach,
	];
</script>

<RuntimeOwners owners={epicenterRuntimeOwners} />
