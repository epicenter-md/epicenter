import { attachDebugCommands } from '../../routes/(app)/_runtime/attach-debug-commands';
import { attachDictationExceptions } from '../../routes/(app)/_runtime/attach-dictation-exceptions.svelte';
import { attachLocalShortcutListener } from '../../routes/(app)/_runtime/attach-local-shortcut-listener.svelte';
import { attachRecordingRetention } from '../../routes/(app)/_runtime/attach-recording-retention.svelte';
import { attachSignInMigration } from '../../routes/(app)/_runtime/attach-sign-in-migration';
import type { RuntimeOwner } from '$lib/runtime/owner';

export const commonRuntimeOwners = [
	{ attach: attachDebugCommands },
	{ attach: attachLocalShortcutListener },
	{ attach: attachDictationExceptions },
	{ attach: attachRecordingRetention },
	{ attach: attachSignInMigration },
] satisfies RuntimeOwner[];
