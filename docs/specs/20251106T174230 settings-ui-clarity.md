# Settings General Page Clarification

## Context
- Users see two sets of clipboard/cursor toggles on the general settings page (transcription vs. transformation) but the UI does not explain the difference.
- Goal is to clarify that transcription toggles apply to audio-run captions, while transformation toggles apply to post-processing steps that run on those captions.

## Plan
- [x] Audit existing `LabeledSwitch` usages on the general settings page to confirm the best place to add helper text.
- [x] Add concise descriptions beneath the transcription/transformation toggles clarifying what each set controls.
- [x] Verify the updated page visually (manual inspection) and lint for syntax issues.
- [x] Explore grouping the switches into clearer sections to reduce repeated helper copy.

## Review
- Added descriptive helper text to each transcription/transformation switch to explain when the action triggers.
- Grouped switches into semantic fieldsets with legends to clarify transcription vs. transformation context while cutting repetition.
- Manually inspected markup for syntax issues; no automated lint run per instructions.
