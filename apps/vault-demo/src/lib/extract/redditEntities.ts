/**
 * Small extraction utility: scan Reddit rows to suggest entities and occurrences.
 * Heuristics:
 *  - Subreddits: /\br\/([A-Za-z0-9_]+)\b/
 *  - Users: /\bu\/([A-Za-z0-9_-]+)\b/
 *  - Domains: any "url" field parsed with new URL().hostname
 */

export type ExtractedEntity = {
	id: string;
	name: string;
	type: 'subreddit' | 'user' | 'domain';
	description?: string | null;
	public_id?: string | null;
	created_at: number;
};

export type ExtractedOccurrence = {
	id: string;
	entity_id: string;
	source_adapter_id: 'reddit';
	source_table_name: string;
	source_pk_json: string;
	discovered_at: number;
};

type TablesToRows = Record<string, Record<string, unknown>[]>;

export function extractEntitiesFromReddit(tablesToRows: TablesToRows): {
	entities: ExtractedEntity[];
	occurrences: ExtractedOccurrence[];
} {
	const subredditRe = /\br\/([A-Za-z0-9_]+)\b/g;
	const userRe = /\bu\/([A-Za-z0-9_-]+)\b/g;

	const entitiesByKey = new Map<string, ExtractedEntity>();
	const occurrenceIds = new Set<string>();
	const occurrences: ExtractedOccurrence[] = [];
	const now = Date.now();

	const ensureEntity = (
		type: ExtractedEntity['type'],
		name: string,
	): ExtractedEntity => {
		const key = `${type}|${name}`;
		let ent = entitiesByKey.get(key);
		if (!ent) {
			ent = {
				id: `${type}:${name}`,
				name,
				type,
				description: null,
				public_id: null,
				created_at: now,
			};
			entitiesByKey.set(key, ent);
		}
		return ent;
	};

	for (const [tableName, rows] of Object.entries(tablesToRows ?? {})) {
		for (const row of rows ?? []) {
			// Scan string fields
			for (const [field, v] of Object.entries(row)) {
				if (typeof v !== 'string' || !v) continue;

				// Domain from URL fields
				if (field === 'url') {
					const host = safeHostname(v);
					if (host) {
						const ent = ensureEntity('domain', host);
						pushOccurrence(
							ent.id,
							tableName,
							row,
							occurrences,
							occurrenceIds,
							now,
						);
					}
				}

				// Subreddit mentions
				for (const m of v.matchAll(subredditRe)) {
					const name = m[1];
					if (!name) continue;
					const ent = ensureEntity('subreddit', name);
					pushOccurrence(
						ent.id,
						tableName,
						row,
						occurrences,
						occurrenceIds,
						now,
					);
				}

				// User mentions
				for (const m of v.matchAll(userRe)) {
					const name = m[1];
					if (!name) continue;
					const ent = ensureEntity('user', name);
					pushOccurrence(
						ent.id,
						tableName,
						row,
						occurrences,
						occurrenceIds,
						now,
					);
				}
			}
		}
	}

	return {
		entities: Array.from(entitiesByKey.values()).sort(byTypeThenName),
		occurrences,
	};
}

function byTypeThenName(a: ExtractedEntity, b: ExtractedEntity): number {
	if (a.type !== b.type) return a.type < b.type ? -1 : 1;
	return a.name.localeCompare(b.name);
}

function safeHostname(url: string): string | null {
	try {
		const u = new URL(url);
		return u.hostname || null;
	} catch {
		return null;
	}
}

function pickStablePk(row: Record<string, unknown>): Record<string, unknown> {
	// Prefer common primary keys if present
	const candidates = ['id', 'permalink', 'message_id', 'username'];
	for (const k of candidates) {
		const v = row[k as keyof typeof row];
		if (typeof v === 'string' && v) return { [k]: v };
		if (typeof v === 'number') return { [k]: v };
	}
	// Next, include a small set of stable fields if present
	const stable: Record<string, unknown> = {};
	const fallbacks = ['url', 'subreddit', 'link', 'post_id', 'thread_id'];
	for (const k of fallbacks) {
		const v = row[k as keyof typeof row];
		if (typeof v === 'string' && v) stable[k] = v;
		if (typeof v === 'number') stable[k] = v;
	}
	if (Object.keys(stable).length > 0) return stable;
	// Final fallback: first two primitive fields in alpha key order
	const prims: [string, unknown][] = Object.keys(row)
		.sort()
		.map((k) => [k, row[k as keyof typeof row] as unknown] as [string, unknown])
		.filter(([, v]) => typeof v === 'string' || typeof v === 'number')
		.slice(0, 2);
	const out: Record<string, unknown> = {};
	for (const [k, v] of prims) out[k] = v;
	return out;
}

function pushOccurrence(
	entityId: string,
	tableName: string,
	row: Record<string, unknown>,
	out: ExtractedOccurrence[],
	seen: Set<string>,
	now: number,
) {
	const pkObj = pickStablePk(row);
	const pkJson = JSON.stringify(pkObj);
	const id = makeOccurrenceId(entityId, tableName, pkJson);
	if (seen.has(id)) return;
	seen.add(id);
	out.push({
		id,
		entity_id: entityId,
		source_adapter_id: 'reddit',
		source_table_name: tableName,
		source_pk_json: pkJson,
		discovered_at: now,
	});
}

function makeOccurrenceId(
	entityId: string,
	table: string,
	pkJson: string,
): string {
	const base = `${entityId}|${table}|${pkJson}`;
	const h = hashString(base);
	return `occ:${h}`;
}

function hashString(s: string): string {
	// Simple 32-bit FNV-1a
	let h = 0x811c9dc5 >>> 0;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16);
}
