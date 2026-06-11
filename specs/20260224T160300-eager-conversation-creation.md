# Eager Conversation Creation

## Problem

`setProvider` and `setModel` silently no-op when no active conversation exists, causing the provider/model dropdowns to revert. The current design allows a "no conversation" state where chat controls are visible but non-functional.

## Solution

Always guarantee a conversation exists. Create one eagerly on initialization, and create a replacement when the last one is deleted. This eliminates the null state entirely.

## Changes

All changes in `apps/tab-manager/src/lib/state/chat.svelte.ts`:

- [ ] **1. Eager creation on init**: After reading conversations from Y.Doc, if none exist, call `createConversation()` immediately. This ensures the very first load always has an active conversation.
- [ ] **2. Make `activeConversationId` non-nullable**: Change type from `ConversationId | null` to `ConversationId`. Remove all null checks on it: `activeConversation` derived becomes non-null too.
- [ ] **3. Remove null guards in setProvider/setModel**: The `if (!conv) return` early returns are no longer needed since a conversation always exists.
- [ ] **4. Remove auto-create in sendMessage**: `sendMessage` currently creates a conversation if none is active. This is now unnecessary: just use the existing active conversation.
- [ ] **5. Create replacement on last-delete**: In `deleteConversation`, when no conversations remain after deletion, create a new one instead of setting `activeConversationId = null`.
- [ ] **6. Remove null guards in getters**: `messages`, `isLoading`, `error`, `status` getters no longer need `if (!activeConversationId)` checks.

## Non-goals

- No schema changes
- No UI changes (AiChat.svelte, ModelCombobox.svelte stay the same)
- No changes to conversation CRUD beyond the delete edge case