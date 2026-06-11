# Rewrite HOW_TO_MONETIZE.md

Rewrite the monetization doc to match the raw, honest voice of GitHub issue #792 while keeping the evolved content as a superset. Apply `writing-voice`, `technical-articles`, and `documentation` skills throughout.

## Source material

- **Issue #792**: The voice and spirit we want. Personal, first-person, honest about uncertainty. Key lines: "honest trade", "scrappy developers building in the open", vision of Epicenter as "SSO for AI applications."
- **Current HOW_TO_MONETIZE.md**: The content we want to keep (superset). AGPL mechanics, CLA rationale, three sustainability streams, developer licensing implications, comps.

## What's wrong with the current doc

1. **Title says "monetize"**: `writing-voice` financial language section bans this word. Title is also a topic label, not a takeaway (`technical-articles`).
2. **10 section headers in 82 lines**: Way too header-heavy. `writing-voice` says use bridge sentences, not headers for every thought. `technical-articles` says use headings sparingly.
3. **Headings are topics, not arguments**: "The short version", "What we considered", "The CLA", "The comps" announce what sections are about, not what they argue.
4. **Multiple bullet/numbered lists**: Violates `technical-articles` max of 1-2 per article.
5. **Bold in body content**: "Hosted sync.", "Enterprise self-host licenses.", "AI compute." violates `technical-articles`.
6. **Opening is meta, not insight**: "Honestly, we're still figuring this out" is tone-right but says something about the document, not the actual point.
7. **Comps are an isolated list**: Should be woven into prose where they're relevant.

## Plan

- [x] Write new title: "How Epicenter Stays Open and Financially Sustainable" (user's choice)
- [x] Write opening paragraph: Vision (foundational data framework, SSO for AI apps), honest tone, delivers the core model in one paragraph.
- [x] Rewrite body as flowing prose with 4 sections:
  - "AGPL does the sales work for us": compliance walkthrough, comps woven in
  - "Your code stays yours": developer licensing, Grafana pattern
  - "Three buyers, three motivations, one foundation": sustainability streams as prose
  - "Contributors keep their copyright": CLA rationale, license grant not assignment
- [x] Closing paragraph with values: "scrappy developers building in the open", "honest trade"
- [x] All headings are arguments, not topics.
- [x] No bold in body, no bullet lists, em dashes closed, no AI dead giveaways.
- [x] Read-aloud test passed.

## Constraints

- Superset of issue #792: every idea from the issue should appear, plus the evolved thinking from the current doc.
- No "monetization", "revenue", "ARR", or pitch-deck language.
- Max 1-2 bullet/numbered lists in the entire doc (comps list is the one candidate, but try prose first).
- Em dashes closed, no space-dash-space.
- Headings are arguments.
- Opening delivers insight, not meta-commentary.
- Closing is a plain implication, no call to action.

## Review

Title changed from "How to Monetize Epicenter" to "How Epicenter Stays Open and Financially Sustainable" per user's choice.

Went from 27 lines (already trimmed from an earlier 82-line version) to 32 lines. Structure:

- Opening paragraph leads with vision (SSO for AI apps) and delivers the full model.
- 4 argument headings replace 4 topic headings.
- Comps (Grafana, Bitwarden, MinIO, AppFlowy, Logseq) woven into relevant sections, no standalone list.
- Three sustainability streams (hosted sync, enterprise self-host, AI compute) as flowing prose.
- CLA explanation kept with rationale for why it exists.
- Closing pulls directly from issue #792 spirit: "scrappy developers building in the open", "honest trade."
- Zero bullet lists, zero bold in body, all em dashes closed.

Every substantive idea from both issue #792 and the prior doc is preserved. The "we looked at other options" paragraph from the issue (SaaS, B2B enterprise memory) is included as a bridge in the AGPL section.
