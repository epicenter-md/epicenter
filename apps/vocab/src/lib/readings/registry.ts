/**
 * The reading overlay: a small ordered registry of deterministic, per-script
 * romanizers (ADR-0105).
 *
 * A reading (pinyin over Han, romaji over kana, ...) is a client-side derived
 * vocab-check: ignore-next-line (prose the English word: what a tutor writes)
 * view over clean message text: the tutor writes plain prose, the message is
 * stored and fed back to the model verbatim, and readings are rendered on top
 * through the `Romanizer`/`Segment`/`<ruby>` seam in `@epicenter/ui/markdown`.
 * Each provider owns one script, is pure and synchronous, and is lazily loaded
 * the first time that script is actually read, so a language's dictionary is
 * fetched (a code-split import, browser-cached) only on demand.
 *
 * Deterministic by design: no model call, no network, no round-trip validation,
 * no non-determinism. That is only possible for scripts whose orthography
 * carries the reading, either phonemically (alphabets like Cyrillic and Greek,
 * the kana syllabary, the Hangul featural alphabet) or lexically (Han, via a
 * per-character pinyin dictionary). Scripts that under-specify pronunciation
 * (abjads like Arabic and Hebrew hide vowels; Devanagari hides schwa deletion;
 * Thai hides word boundaries and tone) have no useful deterministic romanizer
 * vocab-check: ignore-next-line (prose the English word)
 * and get no automatic reading; the tutor's prose can still explain the sound.
 */

import type { Romanizer, Segment } from '@epicenter/ui/markdown';
import { cyrillicProvider } from './cyrillic';
import { pinyinProvider } from './pinyin';
import { romajiProvider } from './romaji';

/**
 * A deterministic, per-script reading provider. It decides cheaply whether a
 * passage contains its script ({@link matches}) and lazily loads its romanizer
 * ({@link load}); the {@link id} is also its load-cache key.
 */
export type ReadingProvider = {
	id: string;
	matches: (text: string) => boolean;
	load: () => Promise<Romanizer>;
};

/**
 * The committed provider set, in claim order. Providers are disjoint by script
 * today, so order is not load-bearing; it becomes the tie-breaker only if two
 * ever claim the same run (the Chinese/Japanese Han overlap, which the pinyin
 * provider avoids by abstaining when kana or hangul is present).
 *
 * To add a language: write a `ReadingProvider` (a small romanizer plus a script
 * test) and add it here. Committed short list, all deterministic, pure-JS, and
 * free of any runtime dictionary download: Chinese, Japanese kana, and Cyrillic
 * are shipped. Korean and Greek were evaluated as cheap adds and deferred: no
 * lightweight package clears the "a wrong reading is worse than none" bar
 * (Korean RR needs cross-syllable assimilation the small packages get wrong;
 * Greek γ is unreliable in every phonetic library tried). Japanese kanji
 * (kuroshiro + kuromoji, ~12MB dict) is deferred as the heavy case. See ADR-0105
 * for the per-script reasoning. An AI-annotation provider for under-specifying
 * scripts is a deliberately refused, earned-later entry: it would be the only
 * provider needing a network call, so it is added only if an
 * Arabic/Hebrew/Thai/Hindi audience becomes real.
 */
export const readingProviders: ReadingProvider[] = [
	pinyinProvider,
	romajiProvider,
	cyrillicProvider,
];

/** One load per provider, shared across every message that needs it. */
const loadedRomanizers = new Map<string, Promise<Romanizer>>();
function loadOnce(provider: ReadingProvider): Promise<Romanizer> {
	const cached = loadedRomanizers.get(provider.id);
	if (cached) return cached;
	const loading = provider.load();
	loadedRomanizers.set(provider.id, loading);
	return loading;
}

/**
 * Compose romanizers into one: each runs only on the runs earlier providers
 * left unread, so a mixed passage (Han + Cyrillic in one sentence) is covered
 * by both. The concatenation invariant, that joining every `segment.text`
 * reproduces the input, is preserved because each romanizer preserves it.
 */
export function composeRomanizers(romanizers: Romanizer[]): Romanizer {
	return (text) => {
		let segments: Segment[] = [{ text }];
		for (const romanize of romanizers) {
			segments = segments.flatMap((segment) =>
				segment.reading ? [segment] : romanize(segment.text),
			);
		}
		return segments;
	};
}

/**
 * The romanizer for one settled message: load every provider whose script
 * appears, then compose them. Pure local work, no network. Resolves to the
 * identity romanizer for all-Latin text (an empty compose), so the caller can
 * inject the result without a branch.
 */
export async function resolveRomanizer(text: string): Promise<Romanizer> {
	const romanizers = await Promise.all(
		readingProviders.filter((provider) => provider.matches(text)).map(loadOnce),
	);
	return composeRomanizers(romanizers);
}
