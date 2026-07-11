---
name: content-distribution
description: Turn one real idea, vault page, article, photo, screenshot, code diff, spec excerpt, or diagram into platform-native artifacts for LinkedIn, X, Reddit, TikTok, Instagram Reels, YouTube Shorts, Medium, Substack, or a personal-site article. Use when creating or editing vault artifacts, choosing a recipe, preparing a platform payload, publishing or recording a public URL, or figuring out what is live for a page.
---

# Content Distribution

Follow [writing-voice](../writing-voice/SKILL.md) for tone. Use
[social-media](../social-media/SKILL.md) when drafting final LinkedIn, X, or
Reddit copy. In the vault, read `AGENTS.md` and `CONTEXT.md`; they own the current
publishing and rendering vocabulary.

## Product Sentence

One authored page can yield several deliberately shaped artifacts. A recipe
guides the collaboration; the artifact holds the durable payload; successful
publications are embedded receipts that freeze it.

```txt
channel ──1:N──► recipe ──1:N──► artifact ◄──N:1── page
                                    └── publications[platform]
```

The vault is curated and flows downward. It does not mirror every remote post,
import platform state, or maintain a provider synchronization engine.

## Default Workflow

1. Select one real `pages/` source and preserve its thesis, evidence, and voice.
2. Choose the recipe for the desired audience promise and payload. Read the
   recipe body; it is editable collaboration guidance, not executable provenance.
3. Create one artifact through the canonical publishing model or app. Its UUIDv7
   filename is opaque identity; its frontmatter points to exactly one `page` and
   `recipe`.
4. Work with the author until the artifact body is the complete platform-ready
   payload. Keep incomplete drafts editable; do not invent status fields.
5. Invoke explicit deterministic tools only when the recipe calls for them.
6. Preview the actual delivery surface. The person approves the external action.
7. Publish manually, through supervised computer use, or through the destination's
   own deployment command.
8. Record the resulting public URL. The first receipt freezes the artifact;
   later receipts may append only for an absent platform declared by the recipe.

## Identity Follows Payload Sameness

One unchanged payload sent to several declared platforms is one artifact with
several receipts. A meaningful platform-specific rewrite is another artifact.

```txt
same video.mp4 → Instagram + TikTok + YouTube
  one artifact, three receipts

LinkedIn argument ≠ X thread
  two artifacts, even when both begin from the same page
```

Do not duplicate an identical artifact just to attach another URL. Do not force
divergent payloads into one artifact merely because they share an idea.

## Recipes Compose Tools; They Are Not Plugins

Recipes are Markdown playbooks. Some collaborations are conversational, some
copy prose almost directly, and some invoke deterministic tools. Do not create a
universal `executeRecipe()` interface or assume every recipe can be run unattended.

```txt
recipe prose
  ├── agent collaboration
  ├── vault video tools
  ├── destination preview/deploy command
  └── supervised browser action
```

Shared TypeScript and Remotion own correctness-sensitive mechanics. Recipe prose
owns editorial intent, questions, review, and handoff.

## Canonical Commands

From the vault:

```bash
bun run vault check
bun run vault page show <page>

bun run vault video plan <artifact-id>
infisical run --env prod --path /vault -- bun run vault video narrate <artifact-id>
bun run vault video preview <artifact-id>

bun run vault publication record <artifact-id> <platform> <public-url>
```

`video preview` always builds the coherent short-video outputs: video, cover, and
review pack. Narration persists paid audio plus caption timing; storyboard cues
derive from current Markdown plus captions.

For a personal-site article, the blog repository owns its external workflow:

```bash
cd ../blog
bun run article preview <artifact-id>
bun run article publish <artifact-id>
```

Article publish deploys and verifies the expected public page, then asks the
vault to record the blog receipt. For manual platforms, copy or upload the payload,
capture the resulting URL, then run `vault publication record`.

## What Is Live

Use the embedded receipts, never filenames or authored status:

```bash
bun run vault page show <page>
```

- No artifact: captured page, not in flight.
- Artifact without receipts: editable draft.
- Artifact with at least one receipt: frozen public payload.
- A correction or second send to the same platform: create another artifact.

## Do Not

- Do not use the retired `variants/`, `placements`, format matrix, dated version
  filenames, or `published_at` draft slots.
- Do not add a provider registry, OAuth layer, retry ledger, remote sync, or
  universal recipe runner.
- Do not generate fake vulnerability, lessons, metrics, or personal stories.
- Do not let platform advice override the source thesis.
- Do not publish or record a receipt before explicit approval and a verified
  public URL.
- Do not edit a frozen artifact or an existing receipt; create a new artifact.
