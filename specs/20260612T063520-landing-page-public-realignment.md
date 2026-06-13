# Landing Page Public Realignment

**Date**: 2026-06-12
**Status**: Implemented (pending owner assets: founder letter text, demo recording)
**Owner**: Braden
**Branch**: `landing/public-realignment`

## One Sentence

Rebuild the epicenter.so root page (`apps/landing/src/pages/index.astro`) as a five-screen public-audience page that sells Whispering as the tonight-useful product and reveals the file-ownership guarantee on scroll, deriving all copy from the new public cut in `docs/positioning.md`.

## Overview

The landing page runs pre-spine copy ("memory" vocabulary, the Destination presented as shipped, "Star on GitHub" as primary CTA). This spec replaces the page structure and copy. The audience split is a locked owner decision: the GitHub README serves developers; epicenter.so serves the general public.

## Motivation

### Current State

`apps/landing/src/pages/index.astro` hero (verbatim):

```txt
h1:   Local-First, Open-Source Apps
sub:  One folder of plain text and SQLite on your machine. Every tool we
      build shares this memory. It's open, tweakable, and yours.
CTA:  [Star on GitHub]  [Join the Discord]
...
h2:   Tools that share your memory
      Record a meeting in Whispering. Edit the transcript in Obsidian.
      Query it with your AI. No copy-pasting, no exports.
      (under a Badge labeled "Available now")
```

This creates problems:

1. **Off-spine vocabulary**: "memory" is the page's organizing metaphor; the positioning spine does not use it.
2. **Destination quoted as shipped**: the Whispering-to-Obsidian-to-AI loop is the vision, displayed under "Available now." `docs/positioning.md` forbids quoting the Destination directly.
3. **Inverted CTA**: the public-facing surface funnels visitors to GitHub, the developer surface. Nothing on the page asks the visitor to install the one thing that ships.
4. **No tonight-useful pitch**: the shipped superpower (hold a key, speak, words land at your cursor) appears nowhere. The page is all guarantee and vision; the public converts on usefulness and trusts the download because of the philosophy, not the reverse.
5. **Jargon for the wrong reader**: "plain text and SQLite" headline a page whose locked audience does not know what SQLite is.

### Desired State

A five-screen page where every claim above the fold is shipped, every mechanism appears below the fold after the benefit it guarantees, and the only primary CTA is downloading Whispering.

## Research Findings

Two research passes inform this spec (full output lives in the planning conversation; the durable conclusions are recorded here).

### Taste corpus (10 OSS and consumer-crypto landing pages)

| Page | What it models |
| --- | --- |
| Signal | Outcome as headline ("Speak Freely"), protocol name literally in parentheses. The model for consumer-facing technical guarantees. |
| Obsidian | Architecture translated to benefit: "local-first" becomes "Your thoughts are yours.", open formats become "you're never locked in." Section headlines all start with "Your". |
| Standard Notes | Consumer metaphors backed by clickable receipts (audits, longevity statement, source). Metaphor without receipts curdles into marketing. |
| Zed | Earliness handled with authorship ("A letter from the team"), not roadmap apologetics. |
| Bun | "View install script" next to the install button: trust gestures cost one link. |
| Tailscale, 1Password | Negative examples: enterprise drift, buzzword tide line ("for the AI era"), CTA addressed to budgets instead of users. |

Extracted principles applied in this spec: outcome as headline with technology demoted to subordinate clauses; "your" as the workhorse word; negation claims ("No ads. No trackers. No kidding.") over feature claims; one CTA verb; wit as a trust signal; one reader per surface.

### Marketer pass (line grades for the public audience)

| Line | Verdict |
| --- | --- |
| "Apps come and go. Your files shouldn't." | Keep. Names a loss everyone has lived. Becomes the ownership section header and opens the public cut. |
| "Local-first apps that write to files you own." | README only. "local-first" is insider vocabulary. |
| "Manage your life in Markdown and SQLite." | Kill for public surfaces. Banked for launch posts aimed at HN. |
| "Speak. It becomes a file you keep." | Vision section only, staged as vision; the flow is not shipped. |
| "If we disappear tomorrow, your files won't notice." | Inside the founder letter only. Never adjacent to the CTA. |
| "This folder is the whole product." | Kill for public surfaces. |

**Key finding**: the page must sell what is useful tonight (Whispering); the ownership guarantee lands harder as a discovered fact on scroll than as a promised one in the hero.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Audience for epicenter.so | Locked (owner) | General public; README owns developers | Owner decision, 2026-06-12. Do not re-litigate. |
| Copy source | 2 coherence | Derive from the public cut in `docs/positioning.md` | New spine cut added 2026-06-12; restates the one-liner with vocabulary translated. |
| Hero subject | 2 coherence | Whispering, the felt experience | The only honest download; proof line rule says no roadmap in heroes. |
| Vocabulary above the fold | 2 coherence | No Markdown, SQLite, local-first, CRDT, Yjs | Public cut framing rule in positioning.md. |
| Vision staging | 2 coherence | Screen 4 says "That's what we're building" explicitly | Lets the page show the folder vision without claiming it ships. |
| Export button gag placement | 3 taste | Screen 2, not the hero | As hero it is a one-trick front door; at screen 2 it demonstrates the guarantee right after the product earns attention. Revisit when: a second app ships and the guarantee needs less explaining. |
| Founder letter placement | 3 taste | Second to last, five lines max | Letters earn their read after usefulness is established; skimmers read two lines and the signature. |
| Agents paragraph | 3 taste | Cut from this page | "Agents" reads as spyware or salesmen to the public. Revisit when: agent workflows are a shipped user-facing feature. |
| Primary CTA | 2 coherence | "Download Whispering, free" with OS detection | One acquisition verb; "free" and platform answer the public's two real questions. |
| GitHub and Discord links | 2 coherence | Footer and nav, not hero CTAs | Developers find the door themselves (corpus principle 12). |

## Architecture

Five screens, one register shift (useful, then funny, then serious, then hopeful, then human):

```txt
Screen 1  THE SUPERPOWER
  h1:  Talk instead of type.
  sub: Whispering is a free speech-to-text app for your computer.
       Hold a key, say it, and the words land wherever your cursor
       is: email, doc, chat, anything.
  CTA: [ Download Whispering, free ]  [ Watch it work (20 seconds) ]
  visual: real screen recording; words appearing in an ordinary email draft

Screen 2  THE GAG
  A giant button labeled "Export your data".
  Click -> flips to "Already done."
  sub: Other apps make you beg for your own data. Epicenter apps keep
       it as ordinary files on your computer from day one, so there is
       nothing to export because nothing was held.

Screen 3  THE GUARANTEE
  h2:  Apps come and go. Your files shouldn't.
  sub: Epicenter apps save everything you make as ordinary files in a
       folder on your computer. Readable now, readable in twenty years,
       no account required.
  visual: a row of generic app icons fading to gray while one plain
          folder stays solid; caption "this folder is on your computer,
          not ours"

Screen 4  THE VISION (staged as vision)
  h2:  Everything you make, in one folder you keep.
  sub: That's what we're building: small apps for speaking, saving,
       and writing that all put their work into ordinary files on your
       computer. The first one, Whispering, is ready today.
  CTA: [ Start with Whispering ]  [ Follow the build ]

Screen 5  THE LETTER
  Five short lines in Braden's first-person voice. Must include the
  "if we disappeared tomorrow, your files wouldn't notice" beat here
  and nowhere else. Ends with an invitation, then the final download
  button.
```

Copy status: screens 1 through 4 above are approved draft copy; refine rhythm but do not change claims. Screen 5 needs owner-written or owner-approved text (see Open Questions).

## Implementation Plan

### Phase 1: Structure and copy

- [x] **1.1** Create branch, audit `apps/landing/src/pages/index.astro` and its components (`RotatingHeadline`, `RotatingTagline`, `CorePrinciples`, `PrinciplesRotatingHeadline`, `ToolCard`) for what survives, what is rewritten, what is deleted.
  > **Note**: Audit result: nothing survives. `ToolCard` did not exist; `RotatingHeadline`, `RotatingTagline`, `CorePrinciples`, `PrinciplesRotatingHeadline`, `ScrollObserver`, and `WaitlistForm` are unreferenced once `index.astro` is rebuilt and are deleted in 4.3.
- [x] **1.2** Rebuild `index.astro` with the five-screen structure and the copy above. Update `BaseLayout` title and meta description to derive from the public cut.
  > **Note**: Title and description are passed per-page through existing `BaseLayout` props; `BaseLayout` itself only gained a named `head` slot so the page can load its display font (Fraunces). Visual direction per Open Question 3: warm paper palette, ink text, single ember accent, Fraunces headlines, monospace captions for the file motif.
- [x] **1.3** Wire the primary CTA to OS-detected download (reuse `components/whispering/OSDetector.svelte` if it fits), with the releases page as fallback.
  > **Note**: Did not reuse `OSDetector.svelte`: it hydrates a Svelte island and renders an empty `href` until JS runs, which fails the no-JS criterion. Instead all three download CTAs are static anchors to the releases page, upgraded to the platform asset by one inline script (same URL scheme as `OSDetector`).
- [x] **1.4** Remove all "memory" copy and the "Available now" Destination quote. Grep the landing app for `memory`, `SQLite`, `local-first`, `CRDT` and relocate or delete each hit per the public cut rule.
  > **Note**: All hits in page and component source are gone (rebuilt `index.astro`, deleted `CorePrinciples.svelte` and `archive/index-v1.astro`). Two `memory` hits remain in `src/content/blog/launch.md`, a dated launch post; left as historical content rather than retroactively edited. Owner call if it should be revised.

### Phase 2: Interactions

- [x] **2.1** Export button flip (screen 2). One state change, no library ceremony; it must work without JS as a static joke (button renders, flip text visible below it) per the Ghostty empty-shell failure in the corpus.
  > **Note**: Without JS the punchline prints below the button; with JS the punchline moves onto the button on click and the static line is hidden (`html.js` gate).
- [x] **2.2** App-icons-fade, folder-stays visual (screen 3). CSS-only preferred.
  > **Note**: Static and no-JS base state is the end state (apps already gray, folder solid), so the metaphor reads without animation. With JS, an IntersectionObserver replays the decay when the row scrolls into view. Reduced motion skips the replay.
- [x] **2.3** Page load and scroll reveals: one well-orchestrated staggered reveal, not scattered micro-interactions.
  > **Note**: Hero stagger is pure CSS (runs with or without JS). Below-fold reveals are gated behind `html.js` so a no-JS read sees everything immediately.

### Phase 3: Assets

- [ ] **3.1** Record the 20-second Whispering demo (hold key, speak a real sentence, words land in an email draft). Until it exists, ship a typed-text simulation clearly built from real app behavior; do not fake the unshipped speak-to-file flow.
  > **Note**: Interim typed-text simulation is shipped (email draft mock, full sentence statically in markup, captioned "Simulated screen"). The recording itself is still outstanding and stays owner work.
- [ ] **3.2** Founder letter final text from owner.
  > **Note**: Placeholder is typeset on screen 5 with bracketed beat descriptions and an HTML comment; the "disappeared tomorrow" beat is reserved for the letter per the marketer pass. Owner text outstanding.

### Phase 4: Verify and clean

- [x] **4.1** Build passes (`bun run` build for `apps/landing`), pages render with JS disabled.
  > **Note**: The build was broken before this spec started: prerendering `/whispering` failed because Vite 7 environments read `resolve.noExternal`, not just `ssr.noExternal`, for the runes-based deps (`bits-ui`, `svelte-toolbelt`, `runed`). Fixed in `astro.config.mjs` as a standalone commit. No-JS reading verified by extracting visible text from `dist/index.html`: all five screens read in order, gag punchline included.
- [x] **4.2** Banned-word and vocabulary sweep (see Success Criteria).
  > **Note**: Zero hits for Markdown/SQLite/local-first/CRDT/Yjs/memory/hype words in `dist/index.html` and in landing page/component source. Also corrected an unshipped claim found during review: the demo card showed `alt+space` key chips, but the shipped push-to-talk default is `Command+Shift+D` (macOS) / `Alt+Shift+D` (elsewhere); replaced with a platform-neutral "hold your shortcut" hint.
- [x] **4.3** Delete dead components and the `archive/index-v1.astro` copy drift if unreferenced.
  > **Note**: Deleted `RotatingHeadline`, `RotatingTagline`, `CorePrinciples`, `PrinciplesRotatingHeadline`, `ScrollObserver`, `WaitlistForm`, `ui/ToolCard` (it lived in `components/ui/`, not `components/`), and `pages/archive/index-v1.astro`. All verified unreferenced; nothing links to `/archive`.

## Edge Cases

### Relationship to /whispering

The site already has `pages/whispering.astro`. The root page now also leads with Whispering. Rule: the root page sells the felt experience in one screen and links out; `whispering.astro` keeps depth (providers, settings, FAQ). Do not duplicate the deep content on the root page.

### Visitor with JS disabled or a crawler

Every screen must read as static copy. The gag degrades to its punchline text; the demo degrades to a still frame plus the headline.

### The visitor who is a developer anyway

They get one quiet door: the footer and nav keep GitHub links, and screen 4's "Follow the build" can point to the repo. Nothing else on the page addresses them; the README is their surface.

## Open Questions

1. **Founder letter text**
   - The voice is the asset; generated text defeats the point.
   - **Recommendation**: Braden drafts five lines; implementer typesets but does not write it. Placeholder lorem is acceptable for layout review.

2. **"Watch it work" treatment**
   - Options: (a) real screen recording, (b) scripted in-page typing simulation, (c) link to a short video.
   - **Recommendation**: (b) now, replaced by (a) when recorded. Both must show shipped behavior only.

3. **Visual and typography direction**
   - The corpus says text-only heroes work when the headline carries an argument, and abstract mood illustration is the weakest choice. Avoid generic AI-slop aesthetics (no purple gradients, no Inter-by-default).
   - **Recommendation**: warm, paper-like, characterful type; the recorded demo is the only hero imagery. Run the frontend-design skill at implementation time.

4. **A "How is it free?" link**
   - The marketer's cost-story direction (subscription resentment) was not chosen for the hero, but the question is real for the public.
   - **Recommendation**: one footer or screen-1-adjacent link to an honest cost explanation (bring your own key, or local and free). Defer if it grows scope.

## Adjacent Work

- Deferred: swap screen 1 for the live speak-to-file demonstration when the Whispering workspace refresh ships. This is the v2 hero; treat "the landing page can finally be the demo" as one definition of done for that refresh.
- Deferred: launch-post copy ("Manage your life in Markdown and SQLite" is banked for HN-facing surfaces, not this page).
- Opportunistic: align `pages/whispering.astro` copy with the spine if touched.

## Success Criteria

- [x] Above the fold contains no instance of: Markdown, SQLite, local-first, CRDT, Yjs, workspace (the folder sense), or any banned hype word.
- [x] Every claim above the fold is shipped behavior; the only vision copy on the page sits under explicit "that's what we're building" staging.
- [x] Primary CTA on screens 1, 4, and 5 is downloading Whispering; "Star on GitHub" is not a hero CTA.
- [x] "memory" vocabulary and the "Available now" Destination quote are gone from the landing app.
  > **Note**: Gone from all page and component source. Two `memory` hits remain in the dated launch blog post (`src/content/blog/launch.md`), left as historical content; owner call whether to revise.
- [x] Page reads correctly with JavaScript disabled.
- [x] `apps/landing` builds clean.
- [x] Meta title and description derive from the public cut.

## Review

**Completed**: 2026-06-12
**Branch**: `landing/public-realignment`

### What Landed

`index.astro` was rebuilt from scratch as the five-screen public page (superpower hero, export gag, ownership guarantee, vision staged as vision, founder letter placeholder), with all copy from the spec's approved drafts and the public cut. Visual direction per Open Question 3's recommendation: warm paper palette, ink text, single ember accent, Fraunces display headlines, monospace captions for the file motif. Eight dead components and the archived v1 page were deleted; the landing build itself was unbroken along the way.

### Deviations and Discoveries

- `OSDetector.svelte` was not reused: it renders an empty `href` until hydration, which fails the no-JS criterion. The three download CTAs are static anchors to the releases page that one inline script upgrades to the platform asset.
- The demo card briefly showed `alt+space` key chips; the shipped push-to-talk default is `Command+Shift+D` (macOS) / `Alt+Shift+D` (elsewhere), so the hint became platform-neutral ("hold your shortcut"). Worth remembering: the real defaults are in `apps/whispering/src/lib/state/device-config.svelte.ts`.
- The landing build was already broken before this work: Vite 7 environments need `resolve.noExternal` (not just `ssr.noExternal`) for `bits-ui`, `svelte-toolbelt`, and `runed`. Fixed in a standalone commit.
- `ToolCard` lived at `components/ui/ToolCard.svelte`, not `components/`; deleted with the rest.
- Open Question 2 resolved as recommended (typing simulation now, recording later). Open Question 4 resolved cheaply: a footer "How is it free?" link points at `/whispering#pricing`.

### Follow-up Work

- Owner writes the five-line founder letter (screen 5 placeholder is typeset and commented; the "disappeared tomorrow" beat is reserved for it).
- Record the real 20-second demo and replace the typed-text simulation (spec item 3.1).
- Owner call: whether to revise the two `memory` mentions in the dated launch blog post.
- Deferred per Adjacent Work: v2 hero swaps in the live speak-to-file demo when the Whispering workspace refresh ships.

## References

- `apps/landing/src/pages/index.astro` - the page being replaced
- `apps/landing/src/pages/whispering.astro` - depth page; boundary defined in Edge Cases
- `apps/landing/src/components/whispering/OSDetector.svelte` - reuse for OS-detected download CTA
- `docs/positioning.md` - the Spine (public cut), Proof Line elements, Earned Vocabulary, banned words
- `README.md` (root) - the developer surface; the contrast this page is allowed to assume
