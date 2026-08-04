/**
 * Vocab's Lens: the namespace it owns, its tables, and its durable values.
 * Isomorphic: no IndexedDB, WebSockets, Svelte state, or browser APIs.
 *
 * Distribution: this file is the `@epicenter/vocab` package root file
 * (the target of the package's `"."` export). The browser entrypoint imports the
 * Lens from here and binds it to a runtime. The shapes here are the wire
 * contract for sync; forking a field shape breaks sync compatibility with peers
 * running the canonical Lens.
 *
 * Composition lives elsewhere:
 *  - `apps/vocab/vocab.browser.ts`
 *      → `openVocabBrowser({ auth, nodeId })`
 */

import type { AgentMessage } from '@epicenter/agent';
import { conversationsTable } from '@epicenter/chat';
import type { ServableModel } from '@epicenter/constants/ai-providers';
import {
	type BoundData,
	defineLens,
	defineTable,
	type RowFor,
} from '@epicenter/data';
import { field } from '@epicenter/field';

/**
 * Vocab runs a single model. It is an app constant, not a per-conversation
 * choice; the canonical conversations table requires a `model`, so Vocab writes
 * this constant on every row and never offers a per-conversation pick. The
 * client also reads it when it answers over the OpenAI-compatible stream.
 */
export const VOCAB_MODEL = 'gemini-3.5-flash' satisfies ServableModel;

/**
 * The multilingual tutor system prompt every Vocab answer is generated under. An
 * app constant like {@link VOCAB_MODEL}: the client passes it to the Epicenter
 * provider when it answers. It lives in this dep-free contract so the prompt is
 * single-homed, read by whichever module builds the stream.
 *
 * The tutor writes plain text only: readings (pinyin, romaji, ...) are a
 * client-side render view added over clean text, never baked into the answer.
 * Keeping the message clean protects it as conversation memory (it is fed back
 * to the model on later turns) and keeps saved entries verbatim (ADR-0102).
 */
export const VOCAB_SYSTEM_PROMPT = `You are a multilingual language tutor. The user is learning a language; answer in that language alongside English, and adapt to whichever language they are studying: infer it from what they ask, and follow if they switch or mix languages.

Guidelines:
- Use English for explanations, transitions, and meta-commentary.
- Use the language being studied for vocabulary, example sentences, and conversational phrases.
- Write plain text only. Never add pronunciation guides, phonetic readings, or romanization (no pinyin, romaji, or transliteration): the client renders readings above the text automatically.
- When teaching vocabulary, present the studied-language word naturally inline inside an English sentence, e.g. "The word for 'to study' is used like this: ...".
- For example sentences, write them in the studied language, then explain in English.
- Adjust difficulty based on context clues from the user's questions.
- Be conversational and encouraging.`;

/**
 * The model Vocab dictates through. Pinned to OpenAI's `whisper-1`, the one
 * model the hosted speech-to-text gateway serves: it returns the `duration` the
 * per-minute meter reads, which the `gpt-4o-transcribe` models drop. An app
 * constant like {@link VOCAB_MODEL}: transcription is a stateless service, so
 * Vocab names its own model rather than borrow another app's. A user who points
 * a device connection at their own OpenAI key serving `whisper-1` dictates
 * through that instead (the connection registry resolves it first).
 */
export const VOCAB_STT_MODEL = 'whisper-1';

// ─────────────────────────────────────────────────────────────────────────────
// Message Model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A complete chat message: the unit Vocab persists. Each finished message is
 * written once, whole, as one JSON blob in the conversation's LWW store keyed by
 * its message id (ADR-0046/0047), the moment a turn finishes.
 *
 * It is the shared {@link AgentMessage} so Vocab rides the one client agent loop
 * (`@epicenter/agent`). Vocab is capability-free, so every message is
 * a single text part, but the parts-array shape is the same one a tool agent
 * fills with tool-call and tool-result parts.
 */
export type VocabMessage = AgentMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Entries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The entries table: the user-curated store of language units of any length
 * (words, phrases, chengyu) captured by selection. One pool, no decks.
 * `stage` is the one acquisition dial (new: saved because you did not know
 * it; understood: you comprehend it; usable: you can produce it). `note` is
 * human-owned: no code path machine-writes it.
 */
export const entriesTable = defineTable({
	fields: {
		text: field.string(),
		note: field.string(),
		stage: field.select(['new', 'understood', 'usable']),
		createdAt: field.instant(),
	},
});

/** One entry row. Row ids are runtime-minted, so the lens owns `id`. */
export type Entry = RowFor<typeof entriesTable>;

export const VocabSettingsRowId = 'settings';

export const settingsTable = defineTable({
	fields: {
		showReadings: field.boolean(),
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Lens
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The isomorphic Vocab Lens.
 *
 * A Lens declares exactly one namespace (ADR-0160), so Vocab interprets the
 * canonical `conversationsTable` shape under its own namespace rather than
 * binding the chat Lens: the conversations are Vocab's, not a namespace another
 * application owns.
 *
 * Conversation transcripts are not rows: each conversation row owns a document
 * holding one {@link VocabMessage} per key (ADR-0046). The open client tab
 * answers in-process (ADR-0043): it streams the live turn in component state
 * and writes each finished message into that document.
 */
export const vocabLens = defineLens({
	namespace: 'so.epicenter.vocab',
	tables: {
		conversations: conversationsTable,
		entries: entriesTable,
		settings: settingsTable,
	},
});

/** Vocab's bound data handle. */
export type VocabData = BoundData<typeof vocabLens.tables>;

/**
 * Readings render by default. The app owns that decision rather than the row
 * definition.
 */
export const SHOW_READINGS_DEFAULT = true;
