<script lang="ts">
	import * as Tabs from '@epicenter/ui/tabs';
	import Applications from './Applications.svelte';
	import { commands, events } from './bindings.gen';
	import Chat from './Chat.svelte';
	import Data from './Data.svelte';
	import { isDesktopHost } from './runtime.ts';
	import { createSession } from './session.svelte.ts';
	import Settings from './Settings.svelte';

	/**
	 * Epicenter: an application beside the others, not a shell above them
	 * (ADR-0209).
	 *
	 * Four panes and nothing else. Data is Epicenter's own job, the raw view of
	 * every namespace; Apps launches the crafted views, which the OS then
	 * switches between. The session is owned here, above the visual contents, and
	 * `Tabs.Content` hides an inactive pane rather than unmounting it, so
	 * switching panes never disturbs the live socket, the transcript, an unsent
	 * draft, or a query you are still editing.
	 */

	const { sessionReady }: { sessionReady: Promise<void> } = $props();
	// The bootstrap promise is fixed for this document lifetime.
	// svelte-ignore state_referenced_locally
	const session = createSession({ ready: sessionReady });

	const isDesktop = isDesktopHost();
	// Native Home opens on the applications it can launch; a browser or remote
	// Home cannot open a window, so it opens on the conversation it can hold.
	// The host answers this synchronously, so the first paint is already right.
	let pane = $state(isDesktop ? 'apps' : 'chat');

	// An application whose local transcription is unavailable can send the user
	// here. The intent lives in the host, so this window claims it rather than
	// being handed it: on mount (Home may have been absent or still booting when
	// the request arrived) and again on each nudge (Home was already running).
	// Taking is destructive, so however many nudges arrive, one request opens
	// Settings once.
	async function claimPendingSection() {
		const section = await commands.takePendingHomeSection();
		if (section === 'transcription') pane = 'settings';
	}
	if (isDesktop) {
		void claimPendingSection();
		void events.homeSectionPending.listen(() => void claimPendingSection());
	}

	const connectionIndicator = {
		connecting: { label: 'Connecting', dot: 'bg-warning' },
		open: { label: 'Connected', dot: 'bg-success' },
		closed: { label: 'Disconnected', dot: 'bg-destructive' },
	} as const;
</script>

<Tabs.Root bind:value={pane} class="h-full text-sm">
	<header class="flex flex-none items-center gap-3 border-b px-3 py-2">
		<Tabs.List variant="line">
			<Tabs.Trigger value="apps">Apps</Tabs.Trigger>
			<Tabs.Trigger value="data">Data</Tabs.Trigger>
			<Tabs.Trigger value="chat">Chat</Tabs.Trigger>
			<Tabs.Trigger value="settings">Settings</Tabs.Trigger>
		</Tabs.List>
		<span
			class="ms-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground"
		>
			<span
				class="size-1.5 rounded-full {connectionIndicator[session.connection]
					.dot}"
			></span>
			{connectionIndicator[session.connection].label}
		</span>
	</header>

	<!-- Each pane owns its own padding so a full-height empty or loading state
	     can center against the whole pane instead of a padded box. -->
	<Tabs.Content value="apps" class="min-h-0 overflow-y-auto">
		<Applications ready={sessionReady} />
	</Tabs.Content>

	<Tabs.Content value="data" class="min-h-0">
		<Data ready={sessionReady} />
	</Tabs.Content>

	<Tabs.Content value="chat" class="min-h-0">
		<Chat {session} />
	</Tabs.Content>

	<Tabs.Content value="settings" class="min-h-0 overflow-y-auto">
		<Settings />
	</Tabs.Content>
</Tabs.Root>
