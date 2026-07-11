/**
 * Deterministic utilities: seeded PRNG, logical-clock UUIDv7, stable
 * serialization, and the state checksum used by the snapshot protocol.
 * No wall clock, no Math.random — identical seeds ⇒ identical runs.
 */

import type { RowState } from './protocol';

/** mulberry32: tiny, deterministic, good enough for schedule generation. */
export function createPrng(seed: number) {
	let a = seed >>> 0;
	return {
		/** float in [0, 1) */
		next(): number {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		},
		int(maxExclusive: number): number {
			return Math.floor(this.next() * maxExclusive);
		},
		pick<T>(items: readonly T[]): T {
			return items[this.int(items.length)];
		},
		chance(p: number): boolean {
			return this.next() < p;
		},
	};
}
export type Prng = ReturnType<typeof createPrng>;

/**
 * UUIDv7-shaped id from a logical clock (harness event counter) + PRNG bits.
 * Time-ordered per creator like real UUIDv7, but fully deterministic.
 */
export function uuidv7(logicalMs: number, prng: Prng): string {
	const hex = (n: number, width: number) =>
		n.toString(16).padStart(width, '0');
	const timeHex = hex(logicalMs, 12); // 48-bit timestamp
	const randA = prng.int(0x1000); // 12 bits
	const randB = prng.int(0x40000000); // 30 bits
	const randC = prng.int(0x100000000); // 32 bits
	return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${hex(randA, 3)}-${hex(0x8000 | (randB >>> 16), 4)}-${hex(randB & 0xffff, 4)}${hex(randC, 8)}`;
}

/** JSON.stringify with sorted object keys — dump comparison + hashing. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** FNV-1a 64-bit over a string, hex. Protocol-level state checksum. */
export function fnv1a64(input: string): string {
	let hi = 0xcbf29ce4;
	let lo = 0x84222325;
	for (let i = 0; i < input.length; i++) {
		lo ^= input.charCodeAt(i);
		// 64-bit multiply by the FNV prime 0x100000001b3, split 32/32.
		const newLo = (lo >>> 0) * 0x1b3;
		const carry = Math.floor(newLo / 0x100000000);
		hi = ((hi * 0x1b3 + lo + carry) & 0xffffffff) >>> 0;
		lo = newLo >>> 0;
	}
	return (
		hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0')
	);
}

/**
 * Canonical serialization of a row-state map (sorted rows, sorted fields,
 * gen/alive included). Shared by server, snapshot producer, and clients so
 * checksums are comparable across implementations.
 */
export function serializeRows(rows: Record<string, RowState>): string {
	const rowIds = Object.keys(rows).sort();
	return rowIds
		.map((id) => {
			const row = rows[id];
			const fields = Object.keys(row.cells)
				.sort()
				.map((field) => `${field}=${JSON.stringify(row.cells[field])}`)
				.join(',');
			return `${id}|${row.gen}|${row.alive ? 1 : 0}|${fields}`;
		})
		.join('\n');
}

export function checksumRows(rows: Record<string, RowState>): string {
	return fnv1a64(serializeRows(rows));
}
