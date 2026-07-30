# Transcription Services

This directory organizes transcription providers (service implementations):

**`/cloud`**: API-based services that send audio to external providers. Require API keys and internet connection.

**`/self-hosted`**: Services that connect to servers you deploy yourself on your own machine. You provide the base URL of your own instance.

**The `local` provider** has no JS transcription service, and no model of its own. Rust owns the GGUF model catalog, capabilities, download, shared-HF-cache resolution, and transcribe.cpp inference (`src-tauri/src/transcription/`), and the host owns the one **active** local model that every ordinary local transcription runs on (ADR-0180). Whispering chooses the route and sends advisory hints only: `transcribe_recording` takes a blob id and a `TranscriptionHints` with no model name, and answers with the exact model that produced the text. Dispatch is inlined in `$lib/operations/transcribe.ts`. Model administration (which model is active, download, delete, unload policy) lives in Epicenter Home; Whispering reads only `get_active_model`, projected by the `$lib/state/active-local-model.svelte.ts` store, so it can name the active model in a readiness blocker.
