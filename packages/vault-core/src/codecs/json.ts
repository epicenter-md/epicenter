import { defineCodec } from '../core/codec';

function stableStringify(value: unknown): string {
	return JSON.stringify(value, replacer, 2);
}

function replacer(_key: string, value: unknown) {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value as Record<string, unknown>).sort())
			out[k] = (value as Record<string, unknown>)[k];
		return out;
	}
	return value;
}

export const jsonFormat = defineCodec({
	id: 'json',
	fileExtension: 'json',
	parse(text) {
		const obj = JSON.parse(text);
		return obj;
	},
	stringify(rec) {
		return stableStringify(rec ?? {});
	},
});
