/**
 * Whispering Workspace Definition Type Tests
 *
 * Verifies provider-specific synced settings reject values that their runtime
 * endpoints cannot use.
 *
 * Key behaviors:
 * - Supported Mistral transcription models are writable
 * - Voxtral Small cannot be stored as a transcription model
 */

import { defineWhispering } from './definition';

using workspace = defineWhispering('OpenAI').create();

workspace.kv.set('transcription.mistral.model', 'voxtral-mini-latest');
workspace.kv.set('transcription.mistral.model', 'voxtral-mini-2602');

// @ts-expect-error — Voxtral Small is a chat model, not a transcription model
workspace.kv.set('transcription.mistral.model', 'voxtral-small-latest');
