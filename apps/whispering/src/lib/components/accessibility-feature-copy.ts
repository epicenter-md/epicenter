/**
 * Terse copy for the one feature that sits behind the macOS Accessibility grant:
 * paste-at-cursor (ADR-0117). Global shortcuts are plugin chords and need no
 * grant. The home notice (`DictationCapabilityNotice`) teases this in a one-line
 * banner and defers the detail to the guide dialog; these strings are the short
 * inline form for the settings surface that annotates the feature in place.
 *
 * The auto-paste annotation reads `pasteBack` followed by the shared
 * `clipboardFallback` "you don't lose anything" line, kept here so that promise
 * stays worded identically wherever a surface spells it out.
 */

/** Shared closing line for surfaces that spell out the clipboard fallback. */
export const clipboardFallback =
	'Without it, transcripts still go to your clipboard.';

/**
 * Paste-back (transcripts land where you're typing), worded as the auto-paste
 * toggle's inline locked hint.
 */
export const pasteBack = 'Pasting at your cursor needs macOS Accessibility.';
