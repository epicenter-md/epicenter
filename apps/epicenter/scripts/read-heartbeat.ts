#!/usr/bin/env bun
/**
 * TEMPORARY. Read the hidden-window measurement ADR-0322 is waiting on.
 *
 * Prints every gap between beats, longest first, alongside what the page
 * believed its visibility was. The question it answers is not "was it slowed
 * down", which costs nothing here, but "did it stop", which would make the
 * design impossible on this platform.
 *
 * Delete this with `heartbeat.ts` once the answer is recorded.
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { appDataDir, epicenterDataRoot } from '@epicenter/constants/app-data';

const path = join(
	appDataDir(epicenterDataRoot(), 'so.epicenter.local-mail'),
	'sqlite',
	'heartbeat.sqlite',
);

if (!(await Bun.file(path).exists())) {
	console.error(`No measurement at ${path}. Open Local Mail first.`);
	process.exit(1);
}

type Beat = { ticked_at: string; visibility: string; since_load_ms: number };
const beats = new Database(path, { readonly: true })
	.query<Beat, []>(
		'SELECT ticked_at, visibility, since_load_ms FROM beats ORDER BY ticked_at',
	)
	.all();

if (beats.length < 2) {
	console.error(
		`Only ${beats.length} beat(s) recorded. Leave it running longer.`,
	);
	process.exit(1);
}

const gaps = beats.slice(1).map((beat, index) => {
	const previous = beats[index] as Beat;
	return {
		seconds:
			(Date.parse(beat.ticked_at) - Date.parse(previous.ticked_at)) / 1000,
		from: previous.ticked_at,
		visibility: beat.visibility,
	};
});

const hidden = gaps.filter((gap) => gap.visibility === 'hidden');
const visible = gaps.filter((gap) => gap.visibility !== 'hidden');
const median = (values: number[]): number => {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] as number;
};

const first = beats[0] as Beat;
const last = beats[beats.length - 1] as Beat;
console.log(`beats            ${beats.length}`);
console.log(`window           ${first.ticked_at} -> ${last.ticked_at}`);
console.log(`asked for        every 10s`);
console.log(
	`visible gaps     ${visible.length}, median ${median(visible.map((gap) => gap.seconds)).toFixed(1)}s`,
);
console.log(
	`hidden gaps      ${hidden.length}, median ${median(hidden.map((gap) => gap.seconds)).toFixed(1)}s`,
);

const worst = [...gaps].sort((a, b) => b.seconds - a.seconds).slice(0, 10);
console.log('\nlongest gaps');
for (const gap of worst) {
	console.log(
		`  ${gap.seconds.toFixed(1).padStart(8)}s  after ${gap.from}  (${gap.visibility})`,
	);
}

const longest = worst[0]?.seconds ?? 0;
console.log('\nverdict');
if (hidden.length === 0) {
	console.log('  inconclusive: the page never reported itself hidden.');
} else if (longest < 120) {
	console.log('  RUNS. Throttled at worst, and throttling costs nothing here.');
} else {
	console.log(
		`  STOPS. A ${longest.toFixed(0)}s gap is suspension, not throttling.`,
	);
	console.log(
		'  ADR-0322 needs beginActivity on macOS, or the platform switch.',
	);
}
console.log(`\n${path}`);
