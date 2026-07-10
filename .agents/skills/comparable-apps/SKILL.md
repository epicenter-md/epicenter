---
name: comparable-apps
description: List 3-5 comparable apps when planning a UX surface to test category fit and surface high-leverage refusals. Use for "what do other apps do", identity, sync state, local-first design.
metadata:
  author: epicenter
  version: '1.0'
---

# Comparable Apps

Related skills: use [one-sentence-test](../one-sentence-test/SKILL.md) to write the cohesion sentence that the comparable-apps check audits against, and [greenfield-clean-breaks](../greenfield-clean-breaks/SKILL.md) when the comparison surfaces an asymmetric win (refuse a feature).

**Core move.** Before designing a user-facing surface, name 3-5 comparable apps and write one line each about what they do for the same problem. Then ask: which category is Epicenter in, and does the proposed design match that category's pattern? When the design diverges from the category, name the reason. When it converges, the comparison is your evidence that the choice is unsurprising.

**Show your work.** Write the table out in the spec or design doc, visibly. The value is in the reader seeing the pattern (or the deviation from the pattern) explicitly, not hidden inside your reasoning.

## Why this skill exists

Epicenter is a local-first workspace platform. Many design questions ("should we cache email", "should we show identity in chrome", "should the sync state be visible", "do we need multi-account") have well-trodden answers in comparable categories. Asking the question explicitly catches two failure modes:

1. **Importing a pattern from the wrong category.** Caching every profile field because Gmail does is wrong; Gmail is communication-first and Epicenter is not.
2. **Inventing a novel pattern when a settled one exists.** Designing a new identity surface when Linear/Notion/Cursor already converged on "avatar in chrome, email in account menu" is gratuitous.

The skill is a coherence gate, not a recipe. Categories are heuristic. When the comparison says "do X" but Epicenter has a load-bearing reason to do Y, the reason goes in the spec; the comparison surfaced the cost of the deviation.

## The taxonomy

```
COMMUNICATION-FIRST       identity is the product; you constantly need
                          to see "who am I sending as"
  examples                Gmail, Slack, Discord, Twitter, iMessage
  chrome                  email/handle visible, multi-account chip prominent
  cache policy            aggressive; identity persisted everywhere
  multi-account           first class

CREDENTIAL VAULT          identity disambiguates which secret store
                          you just unlocked
  examples                1Password, Bitwarden
  chrome                  account email on lock screen
  cache policy            per-vault, persisted
  multi-account           common (personal + work vaults)

INFRA / IDENTITY TOOL     identity disambiguates which network/tenant
                          you are routing through
  examples                Tailscale, Cloudflare Warp, AWS CLI profiles
  chrome                  tray menu shows current tenant
  cache policy            persisted with explicit switch
  multi-account           common (multi-tailnet, multi-profile)

TOOL WITH IDENTITY        identity is a property of the workspace
                          you are operating inside; recessive in chrome
  examples                Linear, Notion, Figma, Asana, Height
  chrome                  avatar in sidebar/corner; email behind a click
  cache policy            session-cached; email shown on demand
  multi-account           supported, but most users have one

IDE                       identity is for authoring/syncing artifacts;
                          you mostly forget it
  examples                Cursor, VS Code, JetBrains IDEs
  chrome                  account icon; email behind a click
  cache policy            session-cached
  multi-account           rare per editor instance

LOCAL-FIRST WORKSPACE     identity is a config detail; the workspace
                          (vault, graph, doc set) is the unit
  examples                Obsidian, Logseq, Anytype, Tana, Roam
  chrome                  nothing identity-related; vault name at most
  cache policy            persisted only if needed for offline sync auth
  multi-account           rare; one workspace = one identity in practice
```

**Epicenter is local-first workspace.** Use this row first; deviations need justification.

## How to apply

Three steps. Don't skip.

1. **State the design question concretely.** Not "what should the auth UI look like" but "where do we display the signed-in user's email, and is it cached on disk." Concrete questions have concrete comparisons.

2. **Pick 3-5 apps across at least two rows of the taxonomy.** Include the row Epicenter belongs to (local-first workspace) plus the row the design is drifting toward. The drift is where the value lives.

3. **Write one line per app, in a table.** Columns are usually: app, category, where the relevant surface appears, what is cached, whether multi-instance is supported. Add columns the specific question demands. Then write the implication: which pattern is Epicenter borrowing, and which is it refusing?

## Worked example: email in chrome

Question: where do we show the signed-in user's email, and should it persist on disk?

| App | Category | Email in chrome? | Where it appears | Persisted? |
| --- | --- | --- | --- | --- |
| Gmail | Communication-first | Yes, prominent | Avatar chip top-right | Yes |
| 1Password | Credential vault | Yes, on unlock | Vault unlock disambiguator | Yes |
| Tailscale | Infra/identity | Yes, in tray | Tray menu | Yes |
| Linear | Tool with identity | Avatar only | Profile menu on click | Yes |
| Notion | Tool with identity | Avatar only | Account settings | Yes |
| Cursor | IDE | Avatar only | Account dropdown | Yes |
| Obsidian | Local-first | No | Sync settings only | Sync only |
| Logseq | Local-first | No | Sync settings only | Sync only |

Implication: Epicenter is local-first; the closest references (Obsidian, Logseq) keep email out of chrome entirely. The tool-with-identity row (Linear/Notion/Cursor) puts an avatar in chrome and reveals email on click. Either is defensible. Gmail's "email everywhere, cached everywhere" pattern is wrong for the category.

Asymmetric win surfaced: refusing the feature of "email in chrome" lets the runtime state stop carrying email at all. Email becomes a fetched query at the one surface that wants to display it.

## Worked example: local model pickers (Whispering)

Question: how should a settings screen present downloadable local models when each is a 0.03 to 1.6 GB download?

| Comparison at decision time | Pattern | Decision |
| --- | --- | --- |
| Ollama and Jan | Recommended starting point; broader library is secondary | Borrow default-first |
| LM Studio | Full catalog browser | Refuse for a four-model catalog |
| superwhisper, MacWhisper, and Handy | Recommended local model with download size visible | Borrow size-on-action |
| Wispr Flow | Cloud transcription, so no local-model picker | Refusal boundary, not Epicenter's category |
| VoiceInk | Picker behavior was not inspected | Exclude from evidence until verified |

Implication: the verified comparison supported default-first, size-on-action,
and a secondary full list. It did not support a catalog browser. The table keeps
unverified candidates visibly outside the conclusion instead of turning a
research target into evidence.

## Worked example: macOS Accessibility onboarding (Whispering)

Question: how should Whispering help users recover when macOS Accessibility is missing or stale after install or update?

| Reference | What it can establish | Evidence boundary |
| --- | --- | --- |
| Apple System Settings | Canonical permission location and recovery path | Platform source of truth |
| Whispering | Written steps, explicit settings action, granted-state feedback, optional hosted video | Current product baseline |
| superwhisper, MacWhisper, Handy, and Wispr Flow | Ways peer apps explain and sequence recovery | UX calibration only; verify before borrowing |
| VoiceInk | Candidate peer reference | Not evidence until inspected |

Implication: Apple owns the permission path. Peer apps can calibrate how the
recovery experience is explained, but they cannot override the platform source
or count as evidence before inspection.

## Other questions this lens answers well

```
- Should sync status show in chrome, or only on demand?
  comm-first: yes; local-first: minimal, often just an icon.

- Should there be a "switch account" affordance?
  comm-first / vault / infra: yes; local-first: no, sign out and sign in.

- Should the app open to a workspace picker or directly to the last workspace?
  comm-first (Slack): picker (workspaces); local-first (Obsidian): last one.

- Should we persist user preferences/settings on the server, the device, or both?
  comm-first: server; local-first: device first, server optionally.

- Should the offline state surface a banner?
  comm-first: yes, prominent; local-first: no, it is the default mode.

- Should we show a "verifying account" loading state?
  comm-first: yes; local-first: no, local data renders first.
```

In every row, the local-first answer is "less identity surface, more workspace-centric framing." Use this as a sanity check against the temptation to import patterns from communication apps.

## Common reveals

- **The Gmail import.** Designs that cache everything identity-related because that is the dominant mental model. Catch this with the taxonomy.
- **The category drift.** Surfaces that quietly turn Epicenter into a communication app (e.g., a presence indicator everywhere, a global "switch account" button). If the comparison says "this is a comm-first pattern," ask why we are drifting.
- **The novel-surface gap.** Designing a status panel or settings shape that has no analog in any comparable app. Sometimes correct; usually a sign the design is generating its own surface area rather than borrowing.
- **The "everyone caches it" argument collapsing.** When you list comparable apps and only the wrong row caches the thing, the argument for caching dissolves.

## Anti-patterns

- **Listing one app and stopping.** "Linear does X" is not a comparison; it is an appeal to one authority. Always at least three, from at least two rows.
- **Listing only apps from the row Epicenter is in.** The comparison loses its bite if every reference says "do nothing in chrome." Include the drift category to show what we are refusing.
- **Picking apps that are not actually comparable.** Comparing Epicenter's account chrome to Photoshop's is noise; Photoshop has no online identity model. The apps must have the surface you are designing.
- **Using the comparison to justify a decision already made.** The table goes in *before* the design converges. If the design is already written, the comparison is a sanity check, not a vote.

## Success criteria

After the move, the design doc has a short comparison table that names the category Epicenter belongs to, the category the design is drifting toward (if any), and the pattern being borrowed or refused. A reader who has never seen the design can tell from the table alone whether the proposal is consistent with the category Epicenter occupies.

## What this skill is not

- Not market research. The point is design coherence, not competitive analysis.
- Not a vote. Five apps doing X is evidence, not authority. Epicenter can refuse the pattern; the comparison just makes the refusal explicit.
- Not a substitute for one-sentence-test or greenfield-clean-breaks. This skill surfaces the question; those skills resolve it.
