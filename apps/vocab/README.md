# Vocab

Multilingual chat tutor. A learner asks about a word, phrase, or sentence; the tutor answers in the language being studied alongside English, inferring that language from the conversation (ADR-0105). The client annotates non-Latin scripts with pronunciation readings (pinyin over Han, romaji over kana, Latin over Cyrillic) using `<ruby>` tags, produced by a deterministic offline registry. The system prompt tells the tutor to write plain text and never include readings itself.

## How it works

**Live answer in state, finished messages in the doc**: Vocab is capability-free (ADR-0043), so the open browser tab answers its own turns, and the live answer needs nothing durable (re-asking is free). `src/routes/+page.svelte` builds the shared `createAgentChatState()` controller with Vocab's system prompt and default model, and `ConversationView.svelte` renders the active `AgentChatThread`. Only finished messages persist (ADR-0046): the user turn the moment it is sent, the assistant turn on a clean finish, each written once as one JSON blob into the conversation's last-write-wins message store (`attachRecords`, keyed by message id). A stopped or failed turn writes nothing; the durable user turn stays, ready to retry. On open, the controller hydrates from the store and observes it, so a message finished on another device shows up here.

**Markdown + readings**: Settled assistant messages render through `@epicenter/ui/markdown` via `ReadingMarkdown.svelte`, which resolves the deterministic per-script romanizers whose script appears in the passage (`src/lib/readings/`, ADR-0105) and composes them behind the shared Markdown component. Readings are a client-side derived view over clean text: pure, offline, lazily loaded per script, with no model call and no network, so a reading can only be missing, never wrong. The shared Markdown component owns sanitization, markdown rendering, and `<ruby>` output. Chinese (`pinyin-pro`), Japanese kana (`wanakana`), and Cyrillic (`transliteration`) ship today; adding a language is one provider file plus one registry line.

**Workspace state**: `vocabWorkspace` in `vocab.ts` is the shared isomorphic definition. It defines `epicenter-vocab`, the `conversations` table (the cheap list: title and timestamps), the `conversations.messages` child doc as a per-id LWW message store (`attachRecords<VocabMessage>`), the `settings` table with its `settings` row, the Vocab model constant, and the `VocabMessage` shape. Transcripts are not a table; they are per-conversation child docs opened from the bound conversations table. `openVocabBrowser()` reads auth once at boot: signed out uses bare local IndexedDB storage, signed in uses principal-scoped storage plus relay sync.

```txt
defineWorkspace()
  -> vocabWorkspace
    -> openVocabBrowser() opens with a browser connection
```

**UI state**: split by lifetime. `src/routes/+page.svelte` owns the page-local root-doc concerns: the conversation list (the `conversations` table), which conversation is active, and CRUD. The per-conversation runtime lives in `ConversationView.svelte`, mounted via `{#key activeConversationId}`, so each conversation gets a real component lifecycle (opened in setup, disposed in `onDestroy`). `ConversationView` opens the active conversation's `messages` store and hands it to `createConversation` (`src/lib/conversation.svelte.ts`), which streams the live turn into `$state`, persists finished messages, and exposes `messages` / `isThinking` / `isGenerating` / `error` plus `send` / `stop` / `retry`.

**Auth**: Google OAuth through the shared Epicenter auth path. Sign-in is optional: Vocab boots into the local workspace first, then uses principal-scoped storage and sync on signed-in boots. `AccountPopover` is the account surface.

**Providers**: `@epicenter/constants/ai-providers` owns the shared servable model registry. `vocab.ts` owns Vocab's Gemini model.

## File map

```
src/
  lib/
    platform/auth.ts       # OAuth auth client
    vocab.ts               # openVocabBrowser singleton + Vocab state
    state/
      dictation.svelte.ts              # dictation state and interruption handling
      inference-connections.svelte.ts  # hosted/custom inference connection registry
      recorder.svelte.ts               # speech recorder wiring
    readings/
      registry.ts        # resolveRomanizer(): loads + composes the per-script providers
      pinyin.ts          # Chinese: per-character pinyin over Han (pinyin-pro)
      romaji.ts          # Japanese: romaji over kana (wanakana)
      cyrillic.ts        # Cyrillic: Latin transliteration (transliteration)
      runs.ts            # shared whole-run walker for run-based providers
  routes/
    +layout.svelte         # Root layout with Toaster
    +layout.ts             # SSR disabled (CSR only)
    +page.svelte             # Main layout: chat state, sidebar + chat area + readings toggle
    auth/callback/+page.svelte # OAuth callback return to app shell
    components/
      ConversationView.svelte  # Keyed per-conversation view; binds the message store to the inference stream
      ReadingMarkdown.svelte   # Renders one settled message with its deterministic reading overlay
      DictationButton.svelte   # Speech input control
      VocabSidebar.svelte      # Sidebar conversation list with create/switch/delete
vocab.ts                    # Shared isomorphic model (tables, KV, VocabMessage shape, conversation child docs)
vocab.browser.ts            # openVocabBrowser runtime wiring
```

## Key decisions

- The conversation list lives in the root workspace doc (`conversations` table); each transcript lives in its own synced child doc, a per-id LWW message store. There is no `chatMessages` table.
- The live answer streams in component `$state`, not the synced doc (ADR-0046): vocab is capability-free, so re-asking is free and only finished messages need to sync. Each finished message is one LWW JSON blob keyed by message id, written the moment a normal app would POST the row.
- The cloud never writes the doc: it is a blind relay plus a stateless metered inference stream (ADR-0033).
- SSR is disabled; the app is CSR-only.
- The system prompt forbids readings (pinyin, romaji, transliteration) in AI responses so the client controls annotation rendering and toggle visibility, and the stored message stays clean for reuse as conversation memory and verbatim entries (ADR-0102, ADR-0105).

## Scripts

```sh
bun dev:vocab      # Start the local API and Vocab UI from the repo root
bun dev:vocab:ui   # Start only the Vocab UI
bun run build      # Production build, from apps/vocab
bun run preview    # Preview production build, from apps/vocab
bun run typecheck  # svelte-check, from apps/vocab
```
