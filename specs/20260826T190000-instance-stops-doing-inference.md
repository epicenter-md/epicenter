# An instance stops doing inference

- **Status:** Draft
- **Date:** 2026-08-26
- **Decision:** [ADR-0264](../docs/adr/0264-an-instance-does-not-do-inference-billing-lives-where-someone-elses-key-is-spent.md)

## One sentence

Delete inference and transcription from `apps/self-host` so an instance is identity, sync, and storage, and a self-hoster configures inference as a device-local connection instead of as a server house key.

## How to read this spec

The decision and its rationale live in [ADR-0264](../docs/adr/0264-an-instance-does-not-do-inference-billing-lives-where-someone-elses-key-is-spent.md). This is the execution plan only. Where the two disagree, the ADR wins.

Phase 1 covers both chat and transcription and is done. An earlier draft gated STT behind building a client-side STT connection; that was wrong. One `Connection` already drives both, so they ship together.

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
| One `Connection` drives both chat and STT | `api-routes.ts:76`; `transcribe()` takes the same `ResolvedConnection` and appends `audio/transcriptions`; Vocab uses `inferenceConnections.resolveOrHosted(VOCAB_STT_MODEL)` and Whispering's `wire` kind uses `entry.resolve()` |

## Accepted losses

1. **Scope containment.** A shared provider key works everywhere; an instance token only worked against the instance. Per-user provider keys recover revocation and accounting but not scope. Deliberate, recorded in the ADR.
2. **First-run.** A fresh self-host session opens chat with no connections. Phase 2 owns the empty state so the picker explains rather than renders blank.
3. **The closed quadrant.** Self-hosted data plus Cloud inference stays impossible until the client can hold two credentials. Not a prerequisite here.

## Implementation plan

### Phase 1: delete self-host inference and transcription (DONE)

- **1.1** Removed `mountInferenceApp`, `mountTranscriptionApp`, and both `rateLimit` policies from `apps/self-host/worker/index.ts` and `apps/self-host/server.ts`.
- **1.2** Inverted both rows in `apps/self-host/runtime-profile.test.ts` from `served` to `absent`, each carrying a `why` citing ADR-0264, keeping Bun and Worker parity.
- **1.3** Replaced the README's "Inference and your house key" section with "Inference is a client setting, not a server key", and removed the house-key comment from `wrangler.jsonc`.
- **1.4** Added the hard constraint to `apps/self-host/AGENTS.md`: no inference or transcription mount, no provider house key.
- **Evidence:** `@epicenter/self-host` typechecks; `runtime-profile.test.ts` 4/0 with both surfaces asserted absent.

### Phase 2: the hosted entry on a self-host session (DONE)

A pre-existing bug, not one the deletion introduced: `hosted.baseURL` is hardcoded to Cloud while `hosted.fetch` carries whatever credential the selected instance yields, so a self-host session sent an instance bearer to Cloud and got a bare 401. `resolveOrHosted` fell back to `hosted` unconditionally.

- **2.1** `hosted` is optional on `createInferenceConnections`. When omitted the hosted candidate is not in the resolution list and `hostedModels` reads empty, so the picker's Epicenter group does not render. Vocab passes it only when `instanceSetting.isDefault()`.
- **2.2** `resolveOrHosted` is gone, collapsed into `resolve(model): ResolvedConnection | null`. Two names for one predicate became one, and the fallback that shipped an unservable id to Cloud is replaced by an honest null on a path `canServe` already blocks.
- **2.3** Added `hostedAlsoServes` for ids the hosted transport serves that nobody picks. Vocab's dictation reached `whisper-1` **through the fallback**, because STT ids are not in the chat picker catalog, so removing the fallback would have silently broken dictation. The dependency is now declared rather than accidental.
- **2.4** New `TranscribeError.NoConnection({ model })`. A caller that resolves a transport before calling `transcribe()` needs a way to report "nothing serves this" without inventing an HTTP status for a request that never happened.
- **2.5** The picker renders a named empty state when there is no hosted transport and no custom connection, instead of a blank list whose only signal is a failed send.
- **Evidence:** app-shell, client, vocab, constants, server, api, api-ui, and self-host all typecheck; app-shell and client suites 46/0; billing and self-host suites 49/0.

### Phase 3: `rateLimit` moves to Cloud (DONE, inverted)

Planned as a deletion, since all four call sites were self-host's. Checking the billing spec first inverted it: overspend there is bounded by "the per-call cap times the rate-limit", and Cloud was never mounting one, so that bound was already untrue. Deleting the primitive would have removed the thing the allow-negative design names as one of its three bounds.

- **3.1** Mounted `rateLimit({ requests: 10, windowSeconds: 5 })` on Cloud's inference and transcription gateways, ahead of the Autumn policies. Per principal. The window is short on purpose: the failure it bounds is a burst at exhaustion, and a fixed window permits its whole quota at once, so `120/60s` would have allowed a 120-call burst at the same sustained rate that `10/5s` caps at ten.
- **3.2** Rewrote the middleware doc for its real consumer, and replaced the "sized for a small trusted group" framing with what it now is: a bound on one-time overshoot at exhaustion, approximate on Cloudflare (per-isolate), explicitly not a sustained-abuse defense.
- **3.3** Corrected ADR-0264's consequence, which had called it deletable.
- **3.4** Scope, stated honestly after reading the plan config rather than the spec's edge-case prose: a paid plan bills overage as revenue (`overage: { priceUsd: 1, billingUnits: 100 }` on Pro), and the free plan sells no overage and is capped to `freeEligible` models, so real bad debt is a free user's burst at exhaustion on a cheap model. Cents. This is cheap insurance, not a designed ceiling.
- **Open:** 10/5s is a starting value, and belongs with the other billing dials (markup, output cap) as one to set with real data. Watch for 429s on legitimate agent loops.
- **Evidence:** api typechecks; rate-limit test 2/0.

### Phase 4 (follow-on, separate change): move the gateways out of the library

With Cloud the only mount site, `mountInferenceApp` and `mountTranscriptionApp` fail the one-sentence test for `packages/server` ("the shared library both deployables consume"). Moving them into `apps/api/worker/` leaves the library with zero model ids and zero vendor URLs, and puts routing next to `model-pricing.ts`, which is the same fact three ways: what we sell, where it routes, what it costs. Sized and decided separately.

## Success criteria

- [ ] `apps/self-host` mounts no inference or transcription gateway on either runtime, asserted by `runtime-profile.test.ts`.
- [ ] `apps/self-host` reads no provider house key and documents none.
- [x] A self-host session never offers the Cloud gateway entry and never emits a bare 401 from the picker.
- [ ] A self-hoster can chat through a device-local connection with no Epicenter server in the inference path.
- [ ] A self-hoster can transcribe the same way, through the same connection.
- [x] `rateLimit` bounds Cloud's post-settle overshoot, making the billing spec's stated bound true.
- [ ] Cloud behavior is unchanged end to end: same catalog, same metering, same credits.

## Interaction with the billing spec

`specs/20260826T120000-inference-credit-billing.md` motivated its registry split partly as "keep the library route and self-host free of pricing." That motivation is now served by removing the wrong consumer instead. The split itself stands: pricing is Cloud-only and keyed by catalog id. Amend that spec's motivation, not its design.

## References

- `packages/server/src/routes/inference.ts` and `transcription.ts` - the routes, Cloud-only after this.
- `apps/self-host/worker/index.ts`, `apps/self-host/server.ts` - the two mount sites to strip.
- `apps/self-host/runtime-profile.test.ts` - the parity test to invert.
- `packages/app-shell/src/inference-picker/connections.svelte.ts` - the registry that drives both chat and STT; `hosted` becomes optional in Phase 2.
- `packages/server/src/middleware/rate-limit.ts` - deleted in Phase 3.
