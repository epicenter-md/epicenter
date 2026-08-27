# An instance stops doing inference

- **Status:** Draft
- **Date:** 2026-08-26
- **Decision:** [ADR-0264](../docs/adr/0264-an-instance-does-not-do-inference-billing-lives-where-someone-elses-key-is-spent.md)

## One sentence

Delete inference and transcription from `apps/self-host` so an instance is identity, sync, and storage, and a self-hoster configures inference as a device-local connection instead of as a server house key.

## How to read this spec

The decision and its rationale live in [ADR-0264](../docs/adr/0264-an-instance-does-not-do-inference-billing-lives-where-someone-elses-key-is-spent.md). This is the execution plan only. Where the two disagree, the ADR wins.

Phase 1 is chat and is unblocked. Phase 3 is transcription and is **blocked** on Phase 2, because the client has no STT equivalent of the inference connection registry. Do not run them out of order: deleting self-host STT first leaves a self-hoster with no transcription path on any target that is not the desktop host.

## Motivation

`packages/server/src/routes/inference.ts` validates against `HOSTED_MODELS_BY_ID` and routes through a two-entry `PROVIDER_UPSTREAM`. Both are Epicenter Cloud's commercial facts. `apps/self-host` mounts that route, so an instance serves the three ids Epicenter sells, through Epicenter's two vendors, spending the operator's key.

The visible symptom: a self-hoster with their own OpenAI key can use `gpt-5.4-mini` and `gpt-5.5` through their own box and nothing else. Their key, our storefront.

## Target shape

```
AXIS 1: DATA                       AXIS 2: INFERENCE
pick ONE, workspace-scoped         resolved per turn, from N connections

  Epicenter Cloud                    Epicenter Cloud /v1   metered, house key
  your instance                      http://box:11434/v1   your Ollama
                                     https://api.openai.com/v1  your key
                                     + add endpoint

                                   your instance does NOT appear here.
```

An instance is a data authority, not an inference endpoint. Metering exists exactly where someone else's key is spent, which is Cloud and nowhere else.

## Grounded facts this rests on

| Fact | How it was verified |
|---|---|
| Every catalog provider permits direct browser calls with a user key | OPTIONS preflight 2026-08-26: OpenAI and Gemini reflect the origin and allow `authorization`; Anthropic answers `Access-Control-Allow-Origin: *` |
| The client already holds N inference connections with per-connection keys and `/v1/models` discovery | `packages/app-shell/src/inference-picker/connections.svelte.ts`, `packages/client/src/connection.ts` `listModels` |
| A self-host session cannot use the Cloud gateway | ADR-0071: one instance selection yields one credential model; `hosted.fetch` is the instance's `auth.fetch` against a hardcoded Cloud base URL |
| `rateLimit` has no consumer outside the four self-host mounts | grep across `apps` and `packages` |
| The desktop host runs transcription locally, on device | `apps/epicenter/src/ui/local-models.svelte.ts` |
| The client has no custom STT connection | grep found no STT equivalent of the inference registry |

## Accepted losses

1. **Scope containment.** A shared provider key works everywhere; an instance token only worked against the instance. Per-user provider keys recover revocation and accounting but not scope. Deliberate, recorded in the ADR.
2. **First-run.** A fresh self-host session opens chat with no connections. Phase 1.5 owns the empty state so the picker explains rather than renders blank.
3. **The closed quadrant.** Self-hosted data plus Cloud inference stays impossible until the client can hold two credentials. Not a prerequisite here.

## Implementation plan

### Phase 1: delete self-host chat inference

- **1.1** Remove `mountInferenceApp` and its `rateLimit` policy from `apps/self-host/worker/index.ts` and `apps/self-host/server.ts`.
- **1.2** Invert the `mountInferenceApp` row in `apps/self-host/runtime-profile.test.ts` from "mounted" to "must not be mounted", keeping Bun and Worker parity.
- **1.3** Delete the "Inference and your house key" section from `apps/self-host/README.md` and the `OPENAI_API_KEY` / `GEMINI_API_KEY` references in self-host config docs. Replace with one paragraph: inference is configured in the client, per device.
- **1.4** Add the hard constraint to `apps/self-host/AGENTS.md`: an instance does not mount an inference gateway or hold a provider house key.
- **1.5** Stop offering the hosted entry on a self-host session, and give the picker an empty state that names what to configure. Today the entry renders and fails with a bare 401 because the instance bearer is the wrong audience (ADR-0053).
- **Evidence:** self-host typechecks on both runtimes; the parity test asserts absence; a self-host session shows no hosted entry and a useful empty state.

### Phase 2: a custom STT connection in the client

Blocks Phase 3. Mirror the inference registry rather than inventing a second shape: a device-local `{ baseUrl, apiKey? }` for an OpenAI-compatible `/v1/audio/transcriptions`, never synced, with Cloud's entry injected the same way `hosted` is today.

- **Evidence:** a self-host session can transcribe against a user-supplied endpoint with no Epicenter server in the path.

### Phase 3: delete self-host transcription

Only after Phase 2 ships.

- **3.1** Remove `mountTranscriptionApp` and its `rateLimit` policy from both self-host entries; invert its parity-test row.
- **3.2** Delete the remaining house-key documentation.
- **Evidence:** self-host mounts session, blobs, and auth only.

### Phase 4: retire `rateLimit`

- **4.1** With all four call sites gone, delete `packages/server/src/middleware/rate-limit.ts`, its test, and both barrel exports. Note in ADR-0076 that its burn-rate cap is retired because the last unmetered house key is gone.
- **Evidence:** no consumer; both deployables typecheck.

### Phase 5 (follow-on, separate change): move the gateways out of the library

With Cloud the only mount site, `mountInferenceApp` and `mountTranscriptionApp` fail the one-sentence test for `packages/server` ("the shared library both deployables consume"). Moving them into `apps/api/worker/` leaves the library with zero model ids and zero vendor URLs, and puts routing next to `model-pricing.ts`, which is the same fact three ways: what we sell, where it routes, what it costs. Sized and decided separately.

## Success criteria

- [ ] `apps/self-host` mounts no inference or transcription gateway on either runtime, asserted by `runtime-profile.test.ts`.
- [ ] `apps/self-host` reads no provider house key and documents none.
- [ ] A self-host session never offers the Cloud gateway entry and never emits a bare 401 from the picker.
- [ ] A self-hoster can chat through a device-local connection with no Epicenter server in the inference path.
- [ ] A self-hoster can transcribe the same way (Phase 3 gate).
- [ ] `rateLimit` has no consumer and is deleted.
- [ ] Cloud behavior is unchanged end to end: same catalog, same metering, same credits.

## Interaction with the billing spec

`specs/20260826T120000-inference-credit-billing.md` motivated its registry split partly as "keep the library route and self-host free of pricing." That motivation is now served by removing the wrong consumer instead. The split itself stands: pricing is Cloud-only and keyed by catalog id. Amend that spec's motivation, not its design.

## References

- `packages/server/src/routes/inference.ts` and `transcription.ts` - the routes, Cloud-only after this.
- `apps/self-host/worker/index.ts`, `apps/self-host/server.ts` - the two mount sites to strip.
- `apps/self-host/runtime-profile.test.ts` - the parity test to invert.
- `packages/app-shell/src/inference-picker/connections.svelte.ts` - the registry Phase 2 mirrors.
- `packages/server/src/middleware/rate-limit.ts` - deleted in Phase 4.
