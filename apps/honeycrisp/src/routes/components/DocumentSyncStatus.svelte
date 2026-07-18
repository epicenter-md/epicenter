<!--
	One-line document connection status for the open note.

	Renders nothing while the document is connected or the runtime has no
	network transport (signed-out device mode): local durability needs no
	banner. Surfaces the two states worth a user's attention: reconnecting
	(edits stay local and durable, syncing resumes on its own) and
	document-full (ADR-0146: byte fullness recovers by deleting content;
	structural fullness only by moving content to a new note).
-->
<script lang="ts">
	import type { RowDocument } from '@epicenter/workspace/sqlite';
	import {
		type DocumentConnectionStatus,
		rowDocumentConnection,
	} from '@epicenter/workspace/sqlite';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	let { document }: { document: RowDocument } = $props();

	const connection = $derived(rowDocumentConnection(document));
	let status = $state<DocumentConnectionStatus | undefined>();
	$effect(() => {
		status = connection?.status;
		return connection?.onStatusChange((next) => (status = next));
	});

	const notice = $derived.by(() => {
		if (!status) return undefined;
		if (status.phase === 'pending') {
			return 'Offline; edits are saved on this device and will sync when reconnected.';
		}
		if (status.phase === 'document-full') {
			return status.recoverable
				? 'This note is too large to sync. Delete some content to resume syncing.'
				: 'This note is too large to sync. Move content into a new note to continue syncing.';
		}
		if (status.phase === 'terminal') {
			return 'Syncing stopped for this note. Reload the app to reconnect.';
		}
		return undefined;
	});
</script>

{#if notice}
	<div
		class="flex items-center gap-2 border-t px-4 py-1.5 text-xs text-muted-foreground"
	>
		<TriangleAlertIcon class="size-3.5 shrink-0" />
		<span>{notice}</span>
	</div>
{/if}
