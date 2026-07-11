# Transcription Services

This directory organizes transcription providers (service implementations):

**`/cloud`**: API-based services that send audio to external providers. Require API keys and internet connection.

**`/self-hosted`**: Services that connect to servers you deploy yourself on your own machine. You provide the base URL of your own instance.

**The `local` provider** has no browser transcription service. Epicenter owns the GGUF model catalog, download lifecycle, shared-HF-cache resolution, and transcribe.cpp inference. The `#runtime` Epicenter root selects `$lib/operations/transcribe.epicenter.ts`, while the browser root selects the remote engine. The catalog and per-model download status are projected by `$lib/state/local-models.svelte.ts`.
