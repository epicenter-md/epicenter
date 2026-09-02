/**
 * TEMPORARY. Measures whether a hidden Epicenter window keeps running.
 *
 * ADR-0322 decides that an application which works without a window is started
 * hidden, and carries one thing it could not decide: whether a hidden WebView
 * is merely throttled, which costs nothing here, or suspended, which would make
 * the whole design impossible on that platform. That is measurable rather than
 * arguable, so this measures it.
 *
 * Every ten seconds it writes one row saying when it ticked and whether the
 * page believed it was visible. Reading the gaps afterwards answers the
 * question: gaps near ten or sixty seconds mean throttling and the design
 * stands; gaps that stop while the window is hidden mean suspension, and the
 * remedy is `NSProcessInfo.beginActivity` and the platform throttling switches.
 *
 * It writes to its own database, `heartbeat`, so it cannot touch a person's
 * mail or their undelivered triage. Delete this file, its import, and that
 * database once the question is answered.
 */

import { epicenter } from './storage';

const BEAT_MS = 10_000;

export async function startHeartbeat(): Promise<void> {
	const opened = await epicenter.openSqlite('heartbeat');
	if (opened.error !== null) {
		console.error('heartbeat: could not open its database', opened.error);
		return;
	}
	const database = opened.data;
	const created = await database.run(
		`CREATE TABLE IF NOT EXISTS beats (
			ticked_at TEXT NOT NULL,
			visibility TEXT NOT NULL,
			since_load_ms INTEGER NOT NULL
		)`,
	);
	if (created.error !== null) {
		console.error('heartbeat: could not create its table', created.error);
		return;
	}

	const loadedAt = performance.now();
	const beat = async () => {
		await database.run(
			`INSERT INTO beats (ticked_at, visibility, since_load_ms) VALUES (?, ?, ?)`,
			[
				new Date().toISOString(),
				document.visibilityState,
				Math.round(performance.now() - loadedAt),
			],
		);
	};

	await beat();
	setInterval(() => void beat(), BEAT_MS);
}
