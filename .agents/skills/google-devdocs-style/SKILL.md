---
name: google-devdocs-style
description: 'Write, revise, and audit developer documentation in Google Developer Documentation Style Guide house style: second person, active voice, present tense, conditions before instructions, sentence-case headings, code font and bold UI conventions, and timeless, globally readable prose. Use when the user asks for Google style, or when drafting or reviewing developer guides, procedures, API reference text, README front doors, or release notes for readers outside this repo. Not for UI strings, commit messages, PR bodies, or code comments, which follow writing-voice.'
user-invokable: true
args:
  - name: target
    description: The document or text to write, rewrite, or audit in Google developer documentation style (optional)
    required: false
---

Produce documentation a developer can act on without rereading: the reader knows who does what, in what order, and what happens next. This skill applies the Google Developer Documentation Style Guide (developers.google.com/style). It is prescriptive by design. Recommend one path rather than listing every option.

## Precedence

When sources conflict, follow this order:

1. The user's explicit request and the destination's requirements.
2. Source facts: quotations, code, commands, filenames, API names, UI labels, product names, and version numbers stay exact even when a style rule would prefer something else.
3. Project style. In this repo, `AGENTS.md` wins. It bans em dash (`U+2014`) and en dash (`U+2013`) characters, so use a colon, comma, semicolon, parenthesis, or sentence break, even though Google permits the em dash.
4. The rules in this file.
5. `references/` and then the live guide.

Depart from a rule when doing so serves the actual reader. Stay consistent afterward.

## Fidelity comes first

Read this before the style rules, because it constrains all of them. A style fix that changes
what the document claims is a worse outcome than the defect it removed.

**Preserve source modality.** `may`, `might`, `can`, `should`, and `will` carry the author's
certainty. "Results may vary" is a hedge about possibility; "Results vary" asserts that they do.
Never drop or strengthen a modal to tighten a sentence.

**Preserve every qualification.** Scope, sample size, region, version, and "not tested above X"
survive rewriting intact. A benchmark's conditions are part of the claim, not padding around it.

**Replace the link text, not the link.** Fixing "click here" means rewriting the anchor text and
keeping the destination. An output with no link is a regression on the reader's actual task.

**A replacement is a direction, not a string to paste.** The word list tells you what is wrong
and where to aim. It does not supply finished wording. When a banned term names a specific
product feature ("run the sanity check"), rename that feature neutrally and keep the definite
reference. Do not paraphrase what you imagine it does: inventing "a final check of your
configuration for completeness" fabricates product behavior and leaves the reader unable to
identify which check to run.

**Invent nothing.** No page titles, no flag semantics, no error screens, no prerequisites, no
acronym expansions, no recovery procedures. If the source does not supply it, the gap is a
finding to report, not a blank to fill.

## The rules that carry the most weight

Ordered by how often they get broken.

**Put the condition before the instruction.** The reader can skip an instruction that does not apply to them. Write "To delete the document, click **Delete**", not "Click **Delete** to delete the document". Write "For more information, see X", not "See X for more information".

**Address the reader as `you`, and use the imperative for steps.** Reserve "we" for the organization speaking ("We recommend"). Never use "we" to mean the reader.

**Name the actor and use active voice.** "The server sends an acknowledgment", not "an acknowledgment is sent". Passive is fine when the actor is irrelevant, the object is the point, or naming the actor would blame the reader ("Over 50 conflicts were found").

**Use present tense.** Reserve "will" for something that genuinely happens later. Replace hypothetical "would" with a conditional: "If you send an unsubscribe message, the server removes you from the list."

**Say required, recommended, or optional. Do not lean on `should`.** Use "must" or a bare imperative for required, "We recommend" for recommended, "can" for optional, and "might" for a possible outcome. The word list allows "should" for an expected action or advisable state, but in prescriptive text it reads as ambiguous.

**Cut excessive claims.** Delete "easy", "simple", "simply", "just", "quickly", "seamless". Avoid "best", "fastest", "always", "never", "ensure", "guarantee", and unqualified "secure". Describe what the thing does instead, or write "helps prevent".

**Keep it timeless.** Delete "currently", "now", "new", "soon", "latest", "as of this writing", "does not yet". If newness matters, name the date or version. Release notes, blog posts, and announcements are exempt, and the exemption is not optional: keep "now available", "new", and "this release" in them. Announcing something is the whole job of that genre, and a release note whose lead reads "X is available" has been flattened into a reference page.

**Sentence case for every heading and title.** A task heading starts with a bare imperative verb ("Create an instance"). A concept heading is a noun phrase ("Migration to Google Cloud"). Do not open a heading with an `-ing` form. One h1 per page, no skipped levels, no links inside headings.

**Write link text that stands alone.** Use the target's title or a descriptive phrase with the key words first. Give a cross-reference its own sentence: "For more information about quotas, see X." Never "click here", "this document", "read more", or a bare URL.

**Split code font from bold.** Code font for anything typed or returned verbatim: commands, filenames, paths, class and method names, environment variables, HTTP status codes, ports, query parameters, console output. Bold for visible UI labels, matching their capitalization. Never inflect a code element as if it were an English word: write "send a `POST` request", not "`POST` the data"; write "the `ADDRESS` constant's value", not "`ADDRESS`'s value".

**Format placeholders as `UPPER_SNAKE_CASE`** with no `MY_` or `YOUR_` prefix, then explain each one after the code block. For one, write "Replace `PROJECT_ID` with ...". For several, write "Replace the following:" and list them in the order they appear. Google italicizes placeholders, but in Markdown `*`NAME`*` nests emphasis around a code span and many renderers emit literal asterisks; plain code font is the safer choice unless you know the renderer handles it.

**Match the list type to the content.** Numbered for a sequence, bulleted for unordered parallel items, description list for term and definition pairs. Introduce every list and table with a complete sentence. Keep items grammatically parallel. Never write a list of one item. Drop "etc." and "and so on"; say what the list leaves out.

**Write procedures as one action per step.** Prefix a nonrequired step with `Optional:`. State the action, then the result, in that order. Format a single-step procedure as a bullet, not as step 1. Skip "please", and skip "run the following command" when you can say what the command accomplishes.

**Write for readers whose first language is not English.** No idioms, no humor, no culture-specific or seasonal references. Keep the relative pronoun ("the rules that you defined"). Replace an ambiguous "it" with the noun. Use one term for one concept throughout.

**Write accessibly and inclusively.** No directional language ("above", "below", "on the right"); use "preceding" and "following", or a label. Never carry meaning by color or position alone, and watch for this in status indicators specifically: "the status turns green" and "Green: ready / Red: failed" both fail, because bolding the word Green is not a second cue. Name the text label, icon, or state word that appears alongside the color. Give every meaningful image alt text under 155 characters, and use `alt=""` for decorative ones. Use allowlist and blocklist, not whitelist and blacklist. Drop "sanity check", "dummy", "crazy", "kill", "abort", and "hit".

**Do not anthropomorphize.** "The PC detects a new device", not "sees". "A `Delimiter` object specifies where to split a string", not "tells the splitter".

**Mechanics.** Serial comma. American spelling. Spell out zero through nine in prose, numerals for 10 and up and for all technical quantities, versions, and percentages. "January 19, 2026" in prose, or `2026-01-19` when a numeric format is required. "For example" and "that is", never "e.g." and "i.e.". Spell out "and" instead of "&".

## Draft or revise

1. Name the reader, their goal, the artifact type, and whether the job is to draft, revise, or audit.
2. Mark what must not drift: facts, qualifications, quoted language, code tokens, UI labels, links, and required structure.
3. Put the outcome or purpose first, in the document, in each section, and in each paragraph. One idea per paragraph.
4. Draft against the rules above.
5. Look up anything specific in `references/`.
6. Run the checklist.

## Look it up

- `references/rules.md`: the full derived rule set by category. Read it when the artifact involves procedures, code samples, command-line syntax, UI instructions, tables, images, API reference text, or a line-level audit.
- `references/word-list.md`: banned words, mandated replacements, and usage restrictions. Read it when you are unsure about a specific word.
- `references/official-pages.md`: an index of live guide pages. Fetch the relevant page for a disputed word, a specialized format, or an explicit compliance request.

The references are a synthesis, not a reproduction. If you have not checked the live guide, do not claim full compliance with it.

## Before you finish

- Does the opening answer the reader's main question?
- Does every instruction name or clearly imply the actor?
- Does every condition appear before the action it governs?
- Does every pronoun have one unmistakable referent?
- Is every heading sentence case, and does every link make sense out of context?
- Are code tokens, UI labels, and product names still exact?
- Are the claims verifiable and free of time anchors?
- Would a reader with limited English get it on the first pass?

Then run the fidelity pass, comparing against the source line by line:

- Does every modal (`may`, `might`, `can`, `will`) still carry its original strength?
- Does every qualification, limit, and number survive?
- Does every link that had a destination still have one?
- Is there a single sentence you wrote that the source does not support? Delete it.

## What this skill does not do

- Do not rewrite when the user asked for an audit. Report findings in priority order with bounded examples, and hand back the questions only the product owner can answer rather than guessing at wording.
- Do not push documentation conventions onto quotations, code, legal text, or a deliberately personal voice.
- Do not flatten prose into a robot's cadence. Prefer the clearest accurate term, including a technical one.
