export function stableJson(value: unknown): string {
	return JSON.stringify(sort(value));
}

function sort(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sort);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sort(child)]),
		);
	}
	return value;
}

/** Small deterministic generator for replayable schedules. */
export class Prng {
	constructor(private state: number) {}

	next(): number {
		this.state |= 0;
		this.state = (this.state + 0x6d2b79f5) | 0;
		let value = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	}

	int(maxExclusive: number): number {
		return Math.floor(this.next() * maxExclusive);
	}
}
