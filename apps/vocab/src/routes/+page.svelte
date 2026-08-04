<script lang="ts">
	import { createAgentChatState } from '@epicenter/app-shell/agent-chat';
	import { fromTable } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { toast } from '@epicenter/ui/sonner';
	import {
		SHOW_READINGS_DEFAULT,
		VocabSettingsRowId,
		VOCAB_MODEL,
		VOCAB_SYSTEM_PROMPT,
	} from '@epicenter/vocab';
	import { onDestroy } from 'svelte';
	import { getVocabApp } from '$lib/context';
	import { buildPracticeOpening } from '$lib/practice';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import ConversationView from './components/ConversationView.svelte';
	import VocabSidebar from './components/VocabSidebar.svelte';

	const vocab = getVocabApp();
	const settingsView = fromTable(vocab.settings);

	function reportBackgroundError(cause: unknown) {
		toast.error('Vocab chat failed', {
			description: cause instanceof Error ? cause.message : String(cause),
		});
	}

	// The shared chat registry (ADR-0047/0059) with Vocab's variation injected:
	// capability-free (no tools, no approval), one general multilingual system
	// prompt, and the hosted VOCAB_MODEL as the default a new conversation starts
	// on. The active conversation lives in internal state (Vocab has no URL seam).
	const chat = createAgentChatState({
		table: vocab.conversations,
		openConversationDocument: (id) => vocab.conversations.openDocument(id),
		reportBackgroundError,
		connections: inferenceConnections,
		agent: {
			buildSystemPrompts: () => [VOCAB_SYSTEM_PROMPT],
			defaultModel: VOCAB_MODEL,
		},
	});

	const settings = $derived(
		settingsView.all.find((row) => row.id === VocabSettingsRowId),
	);
	const readings = $derived(
		settings?.showReadings ?? SHOW_READINGS_DEFAULT,
	);

	onDestroy(() => chat[Symbol.dispose]());

	/** Practice opens its own conversation, titled after the chosen entries, and
	 * the compiled turn is that conversation's first message. Whatever thread was
	 * open is left exactly as it was and stays there to return to. The passage
	 * comes back under the tutor system prompt; nothing is written to the entries.
	 *
	 * Opening one is asynchronous (the row document has to be ready before a turn
	 * can land in it), so a failure to acquire the conversation surfaces the same
	 * way every other background chat failure does. */
	async function practice(entryTexts: string[]) {
		if (entryTexts.length === 0) return;
		try {
			await chat.createConversation(buildPracticeOpening(entryTexts));
		} catch (cause) {
			reportBackgroundError(cause);
		}
	}
</script>

<Sidebar.Provider>
	<VocabSidebar
		conversations={chat.conversations}
		activeConversationId={chat.activeConversationId}
		onCreate={() => chat.createConversation()}
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
					variant={readings ? 'default' : 'outline'}
					size="sm"
					onclick={() =>
						void vocab.settings.patch(VocabSettingsRowId, {
							showReadings: !readings,
						})}
					aria-pressed={readings}
					aria-label="Toggle pronunciation readings"
				>
					{readings ? 'Hide readings' : 'Show readings'}
				</Button>
			</div>
		</header>

		<ConversationView active={chat.active} showReadings={readings} />
	</main>
</Sidebar.Provider>
