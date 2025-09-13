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
		return JSON.parse(text, (_, value) => {
			// Revive pseudo-date objects
			if (isJsonDate(value)) {
				return fromJSONDate(value);
			}
			return value;
		});
	},
	stringify(rec) {
		// Need to override `Date.toJSON` to get desired format
		// Otherwise we get ISO strings directly
		const originalDateStringifier = Date.prototype.toJSON;
		Date.prototype.toJSON = function () {
			return toJSONDate(this) as unknown as string;
		};

		try {
			return JSON.stringify(rec, null, 2);
		} finally {
			Date.prototype.toJSON = originalDateStringifier;
		}
	},
});

// Pseudo-date because we can't serialize Date objects in JSON, unlike YAML
type JsonDate = { $date: string }; // Is that a BSON reference???

function isJsonDate(v: unknown): v is JsonDate {
	return (
		typeof v === 'object' &&
		v !== null &&
		'$date' in v &&
		typeof v.$date === 'string'
	);
}

function toJSONDate(date: Date): JsonDate {
	return { $date: date.toISOString() };
}

function fromJSONDate(jsonDate: JsonDate): Date {
	return new Date(jsonDate.$date);
}
