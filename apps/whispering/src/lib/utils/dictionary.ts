import { nanoid } from 'nanoid/non-secure';
import { settings } from '$lib/state/settings.svelte';

export interface DictionaryEntry {
	id: string;
	spoken: string;
	written: string;
}

export function getDictionary(): DictionaryEntry[] {
	try {
		return JSON.parse(settings.get('transcription.dictionary')) as DictionaryEntry[];
	} catch {
		return [];
	}
}

export function saveDictionary(entries: DictionaryEntry[]): void {
	settings.set('transcription.dictionary', JSON.stringify(entries));
}

export function addEntry(spoken: string, written: string): void {
	const entries = getDictionary();
	entries.push({ id: nanoid(), spoken: spoken.trim(), written: written.trim() });
	saveDictionary(entries);
}

export function removeEntry(id: string): void {
	saveDictionary(getDictionary().filter((e) => e.id !== id));
}

export function updateEntry(id: string, spoken: string, written: string): void {
	saveDictionary(
		getDictionary().map((e) =>
			e.id === id ? { ...e, spoken: spoken.trim(), written: written.trim() } : e,
		),
	);
}

/** Build a vocabulary hint to append to the Whisper prompt. */
export function buildVocabHint(entries: DictionaryEntry[]): string {
	if (entries.length === 0) return '';
	const terms = entries.map((e) => e.written).join(', ');
	return `Vocabulary: ${terms}.`;
}

/** Apply dictionary substitutions to a transcript (case-insensitive whole-word). */
export function applyDictionary(text: string, entries: DictionaryEntry[]): string {
	let result = text;
	for (const { spoken, written } of entries) {
		if (!spoken) continue;
		const escaped = spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		result = result.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), written);
	}
	return result;
}
