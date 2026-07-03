<script lang="ts">
	import {
		AgentChatThread,
		type ConversationHandle,
	} from '@epicenter/app-shell/agent-chat';
	import { Markdown } from '@epicenter/ui/markdown';
	import { agentMessageText } from '@epicenter/workspace/agent';
	import { pinyinRomanizer } from '$lib/romanize/pinyin';
	import { auth } from '$platform/auth';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import { termsState } from '$lib/state/terms.svelte';
	import DictationButton from './DictationButton.svelte';

	let {
		active,
		showPinyin,
	}: { active: ConversationHandle | undefined; showPinyin: boolean } = $props();

	// `active` does not narrow inside a snippet closure (a snippet can outlive the
	// `{#if active}` guard), so the input accessory reads these instead of the
	// handle directly.
	const isGenerating = $derived(active?.isLoading ?? false);

	let saveAffordance = $state<{ text: string; x: number; y: number } | null>(
		null,
	);

	/** The selection's text with ruby annotations stripped: `toString()` would
	 * include the pinyin `<rt>`/`<rp>` nodes, so selecting 学习 with readings
	 * shown would capture "学(xué)习(xí)" instead of the verbatim characters. */
	function selectedTermText(selection: Selection): string {
		const fragment = selection.getRangeAt(0).cloneContents();
		for (const annotation of fragment.querySelectorAll('rt, rp')) {
			annotation.remove();
		}
		return fragment.textContent?.trim() ?? '';
	}

	function handleSelectionChange() {
		const selection = document.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			saveAffordance = null;
			return;
		}

		const text = selectedTermText(selection);
		if (!text) {
			saveAffordance = null;
			return;
		}

		const anchorElement =
			selection.anchorNode instanceof Element
				? selection.anchorNode
				: selection.anchorNode?.parentElement;
		const focusElement =
			selection.focusNode instanceof Element
				? selection.focusNode
				: selection.focusNode?.parentElement;
		// Same container required, not just any two: a drag from one message
		// across the gap into another would otherwise save the whole span.
		const anchorSource = anchorElement?.closest('[data-term-source]');
		const focusSource = focusElement?.closest('[data-term-source]');
		if (!anchorSource || anchorSource !== focusSource) {
			saveAffordance = null;
			return;
		}

		const rect = selection.getRangeAt(0).getBoundingClientRect();
		saveAffordance = { text, x: rect.left + rect.width / 2, y: rect.top };
	}

	function saveSelectedTerm() {
		if (!saveAffordance) return;
		termsState.save(saveAffordance.text);
		document.getSelection()?.removeAllRanges();
		saveAffordance = null;
	}

	/** Land a dictated transcript in the draft for review, appended to whatever is
	 * already typed. Guarded so it is a no-op if the conversation went away. */
	function appendTranscript(text: string) {
		if (!active) return;
		const draft = active.inputValue.trim();
		active.inputValue = draft ? `${draft} ${text}` : text;
	}
</script>

<svelte:document onselectionchange={handleSelectionChange} />

{#if saveAffordance}
	<button
		type="button"
		class="fixed z-50 -translate-x-1/2 -translate-y-full rounded border bg-popover px-2 py-1 text-xs shadow-sm"
		style="left: {saveAffordance.x}px; top: {saveAffordance.y - 6}px;"
		onpointerdown={(event) => event.preventDefault()}
		onclick={saveSelectedTerm}
	>
		Save term
	</button>
{/if}

{#if active}
	<AgentChatThread
		conversation={active}
		connections={inferenceConnections}
		placeholder="Ask something in English..."
		onSignIn={() => void auth.startSignIn()}
	>
		{#snippet inputAccessory()}
			<DictationButton disabled={isGenerating} onTranscript={appendTranscript} />
		{/snippet}
		{#snippet message(msg, streaming)}
			{#if msg.role === 'user' || streaming}
				<!-- Raw text while the answer streams (and for the user's own turn): the
				rich markdown + pinyin pass runs once the message settles. -->
				<div class="whitespace-pre-wrap">{agentMessageText(msg)}</div>
			{:else}
				<div data-term-source>
					<Markdown
						content={agentMessageText(msg)}
						romanizer={pinyinRomanizer}
						showReadings={showPinyin}
					/>
				</div>
			{/if}
		{/snippet}
		{#snippet emptyState()}
			<div
				class="flex flex-1 items-center justify-center text-muted-foreground"
			>
				<p>
					Ask a question in English and get a response in Chinese and English.
				</p>
			</div>
		{/snippet}
	</AgentChatThread>
{/if}
