<script lang="ts">
	import { createAgentChatState } from '@epicenter/app-shell/agent-chat';
	import { Button } from '@epicenter/ui/button';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { VOCAB_MODEL, VOCAB_SYSTEM_PROMPT } from '@epicenter/vocab';
	import { onDestroy } from 'svelte';
	import { getVocabRuntime } from '$lib/context';
	import { runVocabMutation } from '$lib/mutation';
	import { buildPracticeOpening } from '$lib/practice';
	import { reportBackgroundError } from '$lib/report';
	import { createEntriesState } from '$lib/state/entries.svelte';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import { createSettingsState } from '$lib/state/settings.svelte';
	import { setVocabSurface } from '$lib/surface';
	import ConversationView from './components/ConversationView.svelte';
	import VocabSidebar from './components/VocabSidebar.svelte';

	const runtime = getVocabRuntime();

	// The one place the document choice is made (ADR-0233): portable work goes
	// to the account replica when this generation has one, and to the device
	// document otherwise. Everything below reads `data` and never asks again.
	const data = runtime.account?.data ?? runtime.deviceData;

	const entries = createEntriesState({ data });
	setVocabSurface({ entries });

	// The shared chat registry (ADR-0047/0059) with Vocab's variation injected:
	// capability-free (no tools, no approval), one general multilingual system
	// prompt, and the hosted VOCAB_MODEL as the default a new conversation starts
	// on. The active conversation lives in internal state (Vocab has no URL seam).
	const chat = createAgentChatState({
		table: data.tables.conversations,
		reportBackgroundError,
		connections: inferenceConnections,
		agent: {
			buildSystemPrompts: () => [VOCAB_SYSTEM_PROMPT],
			defaultModel: VOCAB_MODEL,
		},
	});

	// How this screen renders is a fact about this screen, so it comes off the
	// DEVICE document whether or not an account is open.
	const settings = createSettingsState({ deviceData: runtime.deviceData });

	onDestroy(() => {
		chat[Symbol.dispose]();
		entries[Symbol.dispose]();
		settings[Symbol.dispose]();
	});

	/**
	 * Practice opens its own conversation, titled after the chosen entries, and
	 * the compiled turn is that conversation's first message. Whatever thread was
	 * open is left exactly as it was and stays there to return to. The passage
	 * comes back under the tutor system prompt; nothing is written to the
	 * entries.
	 */
	function practice(entryTexts: string[]) {
		if (entryTexts.length === 0) return;
		runVocabMutation(
			() => chat.createConversation(buildPracticeOpening(entryTexts)),
			'Could not start a practice session',
		);
	}
</script>

<Sidebar.Provider>
	<VocabSidebar
		conversations={chat.conversations}
		activeConversationId={chat.activeConversationId}
		onCreate={() =>
			runVocabMutation(
				() => chat.createConversation(),
				'Could not start a conversation',
			)}
		onSwitch={(conversationId) => chat.switchTo(conversationId)}
		onPractice={practice}
	/>

	<main class="flex h-dvh flex-1 flex-col">
		<header class="flex items-center justify-between border-b px-4 py-3">
			<div class="flex items-center gap-3">
				<Sidebar.Trigger />
				<h1 class="text-lg font-semibold">Vocab</h1>
			</div>

			<div class="flex items-center gap-2">
				<Button
					variant={settings.showReadings ? 'default' : 'outline'}
					size="sm"
					onclick={() =>
						runVocabMutation(
							() => settings.toggleReadings(),
							'Could not save your reading preference',
						)}
					aria-pressed={settings.showReadings}
					aria-label="Toggle pronunciation readings"
				>
					{settings.showReadings ? 'Hide readings' : 'Show readings'}
				</Button>
			</div>
		</header>

		<ConversationView
			active={chat.active}
			showReadings={settings.showReadings}
		/>
	</main>
</Sidebar.Provider>
