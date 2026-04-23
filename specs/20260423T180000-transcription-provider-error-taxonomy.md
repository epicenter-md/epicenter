# Transcription Provider Error Taxonomy

**Date**: 2026-04-23
**Status**: Proposed
**Author**: Surfaced during wellcrafted PR #114 integration

## Overview

Extract provider-specific error handling from each cloud transcription service into its own `defineErrors` taxonomy. Each provider returns `Result<string, XxxError>` (typed tagged errors) instead of `Result<string, WhisperingError>`. Call sites translate to `WhisperingError` using the existing `WhisperingErr({ title, serviceError })` convention that the rest of the codebase (`recorder.ts`, `ffmpeg.ts`, etc.) already uses.

No new adapter file. No cross-provider unification. Just remove UI concerns from the service layer.

## Motivation

### Current state

Every cloud provider file directly constructs `WhisperingErr(...)` inside its `catch`, tangling service-layer logic with UI copy. The cloud transcription directory is the **only** place in `apps/whispering/src/lib/services/` that imports `$lib/result` — every other service domain (19 `defineErrors` sets, including `FsError`, `HttpError`, `RecorderError`) returns its own tagged error and lets call sites translate.

Three concrete problems:

1. **Inconsistent error classification across providers.** Each provider invents its own approach:
   - `openai.ts` (252 lines) — `instanceof OpenAI.APIError` + switch on `status`. Clean.
   - `groq.ts` (236 lines) — `instanceof Groq.APIError` + switch on `status`. Mirrors openai.
   - `deepgram.ts` (210 lines) — `HttpServiceLive` returns typed `Connection | Response | Parse`, nested switch on status. Clean.
   - `mistral.ts` (135 lines) — `message.includes('401')` **string matching**. Fragile. The Mistral SDK actually exposes `MistralError` with a `statusCode` field — the string matching is obsolete, not a limitation.
   - `elevenlabs.ts` (67 lines) — one catch, one generic `WhisperingErr` for every failure. Lossy.

2. **UI copy lives in the service layer.** Every `401 → "🔑 Authentication Required"` mapping is inlined next to the SDK call. Changing copy means editing the service. Testing the service means importing UI types.

3. **Copy has already drifted.** `openai.ts` 401 copy says "Your API key appears to be invalid" — `deepgram.ts` says "Your Deepgram API key is invalid or expired." Same intent, different strings. No central pressure to align them, and no reason the service layer should be the place that aligns them.

### Desired state

Providers return tagged errors. Call sites translate using the existing `serviceError:` shorthand.

```ts
// cloud/openai.ts
export const OpenaiError = defineErrors({
  MissingApiKey:       () => ({ message: 'OpenAI API key is required' }),
  InvalidApiKeyFormat: () => ({ message: 'OpenAI API keys must start with "sk-"' }),
  FileTooLarge:        ({ sizeMb, maxMb }: { sizeMb: number; maxMb: number }) => ({
    message: `File size ${sizeMb}MB exceeds ${maxMb}MB limit`, sizeMb, maxMb,
  }),
  Unauthorized:        ({ cause }: { cause: OpenAI.APIError }) => ({ message: cause.message, cause }),
  RateLimit:           ({ cause }: { cause: OpenAI.APIError }) => ({ message: cause.message, cause }),
  BadRequest:          ({ cause }: { cause: OpenAI.APIError }) => ({ message: cause.message, cause }),
  PayloadTooLarge:     ({ cause }: { cause: OpenAI.APIError }) => ({ message: cause.message, cause }),
  Connection:          ({ cause }: { cause: OpenAI.APIError }) => ({ message: cause.message, cause }),
  Unexpected:          ({ cause }: { cause: unknown })         => ({ message: extractErrorMessage(cause), cause }),
});
export type OpenaiError = InferErrors<typeof OpenaiError>;

export const OpenaiTranscriptionServiceLive = {
  async transcribe(audioBlob, options): Promise<Result<string, OpenaiError>> {
    if (!options.apiKey) return OpenaiError.MissingApiKey();
    if (!options.apiKey.startsWith('sk-')) return OpenaiError.InvalidApiKeyFormat();

    const sizeMb = audioBlob.size / (1024 * 1024);
    if (sizeMb > MAX_FILE_SIZE_MB) return OpenaiError.FileTooLarge({ sizeMb, maxMb: MAX_FILE_SIZE_MB });

    return tryAsync({
      try: () => new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL })
        .audio.transcriptions.create({ /* ... */ })
        .then((r) => r.text.trim()),
      catch: (error) => {
        if (!(error instanceof OpenAI.APIError)) return OpenaiError.Unexpected({ cause: error });
        switch (error.status) {
          case 401: return OpenaiError.Unauthorized({ cause: error });
          case 429: return OpenaiError.RateLimit({ cause: error });
          case 400: return OpenaiError.BadRequest({ cause: error });
          case 413: return OpenaiError.PayloadTooLarge({ cause: error });
          default:  return OpenaiError.Unexpected({ cause: error });
        }
      },
    });
  },
};
```

Call site in `$lib/query/transcription.ts`:

```ts
case 'OpenAI': {
  const { data, error } = await services.transcriptions.openai.transcribe(blob, opts);
  if (error) {
    return WhisperingErr({
      title: '❌ OpenAI transcription failed',
      serviceError: error,  // auto-fills description from error.message, adds "More details" action
    });
  }
  return Ok(data);
}
```

That's the whole pattern. `WhisperingErr({ title, serviceError })` is defined at `$lib/result.ts:74` and already used by `recorder.ts`, `ffmpeg.ts`, and every other domain in the query layer.

## Why no central adapter?

A previous draft proposed a single `error-adapter.ts` with a big `switch (err.name)` mapping every provider's variants to `WhisperingErr`. Rejected because:

1. **Variant collisions force per-provider branches anyway.** OpenAI's 401 and Deepgram's 401 have different copy today — the adapter would need `if (err.cause instanceof OpenAI.APIError)` inside `case 'Unauthorized'`, recreating the per-provider branching in a single file.
2. **Doesn't match codebase convention.** Every other domain uses `WhisperingErr({ title, serviceError })` at the call site. Introducing a parallel pattern for transcription alone would be inconsistent.
3. **The adapter becomes a merge-conflict bottleneck.** Every provider PR touches one file.

If later we find the same copy duplicated across 3+ call sites in `transcription.ts`, we can extract helpers (`authRequiredNotification({ provider })`). Helpers can emerge from duplication; reversing an early unification is harder.

## The two-layer split

```
┌─────────────────────────────────┐
│   UI layer (query/transcription)│   WhisperingErr({ title, serviceError: err })
├─────────────────────────────────┤
│   Provider layer                │   returns Result<string, XxxError>
│   (cloud/openai.ts, etc.)       │   no WhisperingErr, no UnifiedNotificationOptions
└─────────────────────────────────┘
```

Provider files must not import `$lib/result`. That's the one structural rule.

## Per-provider error sets

Each provider's variants reflect what its mechanism actually distinguishes. No lowest-common-denominator set.

### openai, groq — SDK error classes

Both SDKs expose `Provider.APIError` with `.status`. Pattern:

```ts
catch: (error) => {
  if (!(error instanceof OpenAI.APIError)) return OpenaiError.Unexpected({ cause: error });
  switch (error.status) { /* ... */ }
}
```

Variants: `Unauthorized | RateLimit | BadRequest | NotFound | PermissionDenied | UnprocessableEntity | PayloadTooLarge | UnsupportedMediaType | ServiceUnavailable | Connection | Unexpected` + pre-validation (`MissingApiKey`, `InvalidApiKeyFormat`, `FileTooLarge`).

### mistral — SDK error class (previously string-matched)

The Mistral SDK ships `MistralError` at `@mistralai/mistralai/models/errors/mistralerror`:

```ts
export declare class MistralError extends Error {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Headers;
  readonly contentType: string;
  readonly rawResponse: Response;
}
```

Use `instanceof MistralError` + switch on `statusCode`. Same shape as openai/groq. The existing `message.includes('401')` at `mistral.ts:79` becomes a tiny typed switch. This is a straight improvement — no HttpServiceLive migration needed.

One naming note: the SDK's class is called `MistralError`, which would collide with our own tagged error set. Import with an alias (`import { MistralError as MistralSdkError } from '@mistralai/mistralai/models/errors/mistralerror'`) or name our tagged set `MistralTranscriptionError` to disambiguate.

### deepgram — HttpServiceLive

`HttpServiceLive.post()` already returns typed `HttpError = Connection | Response | Parse`. Map those to `DeepgramError` variants:

```ts
const { data, error: httpError } = await HttpServiceLive.post({ /* ... */ });
if (httpError) {
  switch (httpError.name) {
    case 'Connection': return DeepgramError.Connection({ cause: httpError });
    case 'Parse':      return DeepgramError.Parse({ cause: httpError });
    case 'Response': {
      switch (httpError.status) {
        case 401: return DeepgramError.Unauthorized({ cause: httpError });
        case 429: return DeepgramError.RateLimit({ cause: httpError });
        default:  return DeepgramError.Unexpected({ cause: httpError });
      }
    }
  }
}
```

### elevenlabs — minimal upgrade

Currently a single `catch` that produces one generic `WhisperingErr`. Don't invent granularity that doesn't exist — start with `MissingApiKey | FileTooLarge | Unexpected`. The ElevenLabs SDK does ship status-specific error classes (`UnprocessableEntityError`, `ForbiddenError`, `BadRequestError`, `NotFoundError`, `TooEarlyError`), so if distinctions become worth making later, add variants incrementally.

## SDK dependencies stay

Each provider keeps its SDK. The SDKs provide multipart upload, auth, typed request shapes, and (crucially) typed errors. Rebuilding that in `HttpServiceLive` is strictly worse for openai/groq/mistral/elevenlabs. Deepgram stays on `HttpServiceLive` because it already works — no SDK was needed for that simple REST API.

SDK replacement (e.g., for bundle-size reasons) is a separate decision. Not part of this spec.

## File organization

```
apps/whispering/src/lib/services/transcription/cloud/
├── openai.ts        # OpenaiError + OpenaiTranscriptionServiceLive
├── groq.ts          # GroqError + Groq...
├── mistral.ts       # MistralTranscriptionError (SDK collision) + Mistral...
├── deepgram.ts      # DeepgramError + Deepgram...
└── elevenlabs.ts    # ElevenlabsError + Elevenlabs...
```

Colocate each `XxxError` in its provider file — same convention as `FsError` in `fs.ts`, `HttpError` in `http/types.ts`, etc. It's part of the provider's public API.

## Migration plan

Provider-by-provider, cleanest first. Each is an independent PR. The only cross-PR file is `query/transcription.ts`, which has one case per provider — each migration updates its own case.

1. **elevenlabs** (67 lines — warm-up). Minimal error set. Proves the pattern end-to-end including the call-site change.
2. **deepgram** (210 lines — HTTP-typed already). Mechanical lift of existing switch.
3. **openai** (252 lines — reference SDK pattern). Largest but straightforward.
4. **groq** (236 lines — mirrors openai). Copy-paste with type swap.
5. **mistral** (135 lines — SDK typed errors, replaces string matching). Fixes the fragility bug as a side effect.

### Test plan per step

Whispering has no existing unit tests for these services, so "unit-testable providers" is a structural improvement, not an immediate backlog. For each migrated provider:

- Manual smoke test: trigger each error path (invalid key, oversized file, rate limit if easy, network disconnection) and confirm the `WhisperingErr` shown matches today's copy as closely as possible.
- Type-check: `bun run check` in `apps/whispering`.
- Runtime check: `bun run dev` and exercise the provider.

Writing unit tests becomes possible after this refactor but is scheduled separately.

## Open questions

1. **Pre-validation errors (`MissingApiKey`, `FileTooLarge`).** Input validation, not runtime errors. Could hoist to a pre-check layer. For now, keep as tagged variants — matches today's shape and defers the bigger refactor. Flag as possible follow-up.
2. **`InvalidApiKeyFormat`.** Only openai validates the `sk-` prefix today. Keep provider-specific; don't force other providers to add one.
3. **`Connection` variant shape.** OpenAI and Groq surface connection errors through `APIConnectionError` subclass; variant `cause` type may need adjustment per provider.

## Non-goals

- Creating a central adapter or cross-provider error union.
- Changing UI copy. Post-migration, notifications should read as close to today as possible. Copy iteration is a separate pass.
- Replacing provider SDKs.
- Adding unit tests (enabled by this refactor, scheduled separately).

## Expected outcome

- **Copy moves out of the service layer.** All UI strings live at `transcription.ts` call sites.
- **Mistral string-matching goes away.** Replaced by `instanceof MistralError` + typed switch.
- **ElevenLabs gets real error granularity** (at least pre-validation variants separated from the catch-all).
- **Provider files decouple from `$lib/result`.** Testable without pulling in notification schemas.
- **Line-count change is modest** — roughly 900 → ~750 lines across the 5 providers, with ~50 net lines added at call sites. The point isn't LOC reduction; it's separating concerns.
- **Pattern consistency.** Transcription providers stop being the outlier domain that owns UI copy.
