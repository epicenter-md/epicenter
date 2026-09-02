# 0333. The Privacy & Processing surface owns each pipeline stage's destination

- **Status:** Accepted
- **Date:** 2026-07-03
- **Renumbered from 0101 (2026-09-01).** Two branches each kept 0101 as a provisional number and both merged, so `ADR-0101` cited two decisions. The more-cited record keeps the integer and this one took the next free number. Every `ADR-0101` citation elsewhere in the tree means the record that kept it.

## Context

Whispering's capture pipeline has two stages that can each run locally or on a provider: transcription of the audio, then Polish and Recipes over the transcript text. The choice of where each stage runs had no single owner. Transcription's provider lived on a Transcription settings page, while the completion provider (`completion.provider` and `completion.model`) was a synced setting with no UI writer at all, so local Polish through a Custom endpoint was unreachable in the app. Credentials lived on a separate "API Keys" catalog that listed every provider regardless of what was selected. The privacy copy derived audio locality from a static provider `location` label, which mislabeled a self-hosted or localhost endpoint as a send to a cloud vendor.

## Decision

One "Privacy & Processing" settings surface owns the destination of each pipeline stage. It shows two rows, Audio (transcription) and Text (Polish and Recipes). Each row is a provider picker, a resolved status line, the selected provider's credentials inline, and the model.

Credentials are an implementation detail of the selected destination. You configure them inline under the provider you pick, not in a separate catalog, so the "API Keys" page is deleted.

Locality is resolved from the execution target, not a provider category label. A local engine runs in-process. A network provider's locality follows its resolved endpoint host: a loopback endpoint stays on-device whether the provider is labeled cloud or self-hosted. One resolver produces this fact for both the settings surface and the pipeline privacy sentence, so every surface agrees on where data goes.

## Consequences

- `completion.provider` and `completion.model` finally have a UI owner, so local Polish through Ollama or LM Studio (the Custom provider) is reachable in the app.
- A self-hosted or localhost endpoint reads as on-device on every surface, which fixes the earlier mislabel. Provider `location` labels no longer drive privacy copy.
- Credentials are no longer browsable in one place. To stage a key for a provider you are not using, select it, enter the key, and switch back. Keys persist per provider under `providers.<id>.apiKey`, so nothing is lost. This refuses bulk credential management to collapse a duplicate ownership surface.
- The Transcription settings page and the API Keys catalog are both deleted; their content moves inline onto Privacy & Processing. `ProviderConfigFields` is reused inline and stays.
- Status reads as two channels, not one enum: destination is plain prose, missing setup is a warning `Alert`. Audio keeps its model inline because the transcription model carries cost and accuracy tradeoffs. Text hides fixed-list models behind an Advanced disclosure but keeps free-form models (Custom, OpenRouter) inline, because they are required setup with no safe default.

This extends ADR-0099, where Polish and Recipes were unified onto a single shared completion default; that shared default is the "Text" destination this surface now owns.
