import sqlite3InitModule from '/vendor/index.mjs';

const sqlitePromise = sqlite3InitModule();

function configure(database, mode) {
	database.exec(`
		PRAGMA busy_timeout = 5000;
		PRAGMA journal_mode = DELETE;
		PRAGMA synchronous = ${mode};
		PRAGMA temp_store = MEMORY;
	`);
	database.exec(`
		CREATE TABLE IF NOT EXISTS markers (
			id INTEGER PRIMARY KEY,
			payload TEXT NOT NULL
		) STRICT;
	`);
}

function insertMarker(database, marker, payload) {
	database.exec('BEGIN IMMEDIATE');
	try {
		database.exec({
			sql: 'INSERT OR REPLACE INTO markers (id, payload) VALUES (?, ?)',
			bind: [marker, payload],
		});
		database.exec('COMMIT');
	} catch (cause) {
		database.exec('ROLLBACK');
		throw cause;
	}
}

function openDatabase(sqlite, databasePath, mode) {
	if (!sqlite.capi.sqlite3_vfs_find('opfs')) {
		throw new Error('SQLite OPFS VFS is unavailable');
	}
	const database = new sqlite.oo1.DB(databasePath, 'c', 'opfs');
	configure(database, mode);
	return database;
}

self.onmessage = async (event) => {
	let database;
	try {
		const sqlite = await sqlitePromise;
		const message = event.data;
		database = openDatabase(sqlite, message.databasePath, message.mode);
		if (message.kind === 'prepare') {
			const value = {
				journalMode: database.selectValue('PRAGMA journal_mode'),
				synchronous: database.selectValue('PRAGMA synchronous'),
			};
			database.close();
			self.postMessage({ ok: true, value });
			return;
		}
		if (message.kind === 'benchmark') {
			const payload = 'x'.repeat(message.payloadBytes);
			const commitMs = [];
			for (let index = 0; index < message.iterations; index += 1) {
				const startedAt = performance.now();
				insertMarker(database, index, payload);
				commitMs.push(performance.now() - startedAt);
			}
			database.close();
			self.postMessage({ ok: true, value: { commitMs } });
			return;
		}
		if (message.kind === 'commit') {
			const payload = 'x'.repeat(message.payloadBytes);
			const startedAt = performance.now();
			insertMarker(database, message.marker, payload);
			const commitMs = performance.now() - startedAt;
			self.postMessage({ ok: true, value: { commitMs } });
			return;
		}
		if (message.kind === 'verify') {
			const present =
				database.selectValue('SELECT count(*) FROM markers WHERE id = ?', [
					message.marker,
				]) === 1;
			const integrity = database.selectValue('PRAGMA integrity_check');
			database.close();
			self.postMessage({ ok: true, value: { present, integrity } });
			return;
		}
		throw new Error(`Unknown command: ${message.kind}`);
	} catch (cause) {
		try {
			database?.close();
		} catch {}
		self.postMessage({
			ok: false,
			error: cause instanceof Error ? cause.stack : String(cause),
		});
	}
};
