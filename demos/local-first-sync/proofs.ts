/**
 * Executable proofs of the 12 product-contract properties.
 *
 * Drives two isolated browser clients (separate Playwright contexts = fully
 * separate OPFS/localStorage) against the canonical Bun server, which is
 * started mid-run — proofs 1-3 execute with NO server process alive.
 *
 * Usage: vite dev server must be running (`bun run dev`), then:
 *   bun proofs.ts
 */

import { type Subprocess, spawn } from 'bun';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright';

const VITE = 'http://localhost:5199';
const SERVER = 'http://localhost:8788';
const SELFHOST = 'http://localhost:8789';

const results: { n: number; name: string; pass: boolean; detail: string }[] =
	[];
function record(n: number, name: string, pass: boolean, detail = '') {
	results.push({ n, name, pass, detail });
	console.log(`  ${pass ? 'PASS' : 'FAIL'}  #${n} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function demoEval<T>(page: Page, script: string): Promise<T> {
	return page.evaluate(script) as Promise<T>;
}

async function openApp(
	context: BrowserContext,
	params: Record<string, string>,
): Promise<Page> {
	const page = await context.newPage();
	const query = new URLSearchParams(params).toString();
	// Retry once: vite's first-visit dep optimization can force a reload
	// mid-evaluate, which surfaces as a destroyed execution context.
	for (let attempt = 0; ; attempt++) {
		try {
			await page.goto(`${VITE}/client/notes.html?${query}`);
			await page.waitForFunction('window.demo !== undefined');
			await page.evaluate('window.demo.ready');
			return page;
		} catch (error) {
			if (attempt >= 2) throw error;
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
}

function startServer(args: string[]): Subprocess {
	const proc = spawn(['bun', join(import.meta.dir, 'server/main.ts'), ...args], {
		stdout: 'inherit',
		stderr: 'inherit',
	});
	return proc;
}

async function waitForServer(url: string) {
	for (let i = 0; i < 50; i++) {
		try {
			await fetch(`${url}/debug/notes`, {
				headers: { authorization: 'Bearer probe' },
			});
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	throw new Error(`server at ${url} did not come up`);
}

async function serverNotes(url = SERVER, token = 'braden') {
	const response = await fetch(`${url}/debug/notes`, {
		headers: { authorization: `Bearer ${token}` },
	});
	return (await response.json()) as Record<string, unknown>[];
}

async function titles(page: Page): Promise<Map<string, Record<string, unknown>>> {
	const rows = await demoEval<Record<string, unknown>[]>(
		page,
		'window.demo.listTitles()',
	);
	return new Map(rows.map((row) => [String(row.id), row]));
}

async function settle(ms = 800) {
	await new Promise((r) => setTimeout(r, ms));
}

rmSync(join(import.meta.dir, 'server/data'), { recursive: true, force: true });

const browser = await chromium.launch();
const contextA = await browser.newContext();
const contextB = await browser.newContext();
const contextC = await browser.newContext();
const contextD = await browser.newContext();
const contextE = await browser.newContext();
let server: Subprocess | null = null;
let selfhost: Subprocess | null = null;

try {
	// ── Proofs 1-3: server process does not exist yet ─────────────────────────
	console.log('\nPhase 1: anonymous local-only (no server process running)');
	let pageA = await openApp(contextA, { profile: 'A' });
	const serverRequests: string[] = [];
	pageA.on('request', (request) => {
		if (request.url().startsWith(SERVER)) serverRequests.push(request.url());
	});

	const id1 = await demoEval<string>(pageA, `window.demo.createNote('first')`);
	const id2 = await demoEval<string>(pageA, `window.demo.createNote('second')`);
	const id3 = await demoEval<string>(pageA, `window.demo.createNote('third')`);
	await settle(300);
	let list = await titles(pageA);
	record(
		1,
		'create + query before any server exists',
		list.size === 3 && serverRequests.length === 0,
		`rows=${list.size}, server requests=${serverRequests.length}`,
	);

	await pageA.reload();
	await pageA.waitForFunction('window.demo !== undefined');
	await pageA.evaluate('window.demo.ready');
	list = await titles(pageA);
	record(2, 'restart restores complete local database', list.size === 3, `rows=${list.size}`);

	const t0 = Date.now();
	await demoEval(pageA, `window.demo.patchCell('${id1}', 'title', 'first-edited')`);
	await settle(200);
	list = await titles(pageA);
	const domHasEdit = (await pageA.textContent('#notes'))?.includes('first-edited');
	record(
		3,
		'local mutation updates UI with no network round trip',
		list.get(id1)?.title === 'first-edited' && domHasEdit === true && serverRequests.length === 0,
		`latency<=${Date.now() - t0}ms, server requests=${serverRequests.length}`,
	);

	// ── Proof 4: sign-in migration, local DB is the destination ──────────────
	console.log('\nPhase 2: sign-in (server starts now; migration runs OFFLINE)');
	server = startServer(['--mode', 'hosted']);
	await waitForServer(SERVER);

	await demoEval(pageA, 'window.demo.setOnline(false)');
	const { plan } = await demoEval<{
		plan: { inserts: unknown[]; cellImports: unknown[] } | null;
	}>(pageA, `window.demo.signIn('braden', 'add')`);
	list = await titles(pageA);
	const localMigrated = list.size === 3 && plan !== null && plan.inserts.length === 3;
	const serverEmpty = (await serverNotes()).length === 0;
	await demoEval(pageA, 'window.demo.setOnline(true)');
	await settle(1500);
	const serverAfter = await serverNotes();
	record(
		4,
		'sign-in migrates into principal-owned LOCAL db (server not destination)',
		localMigrated && serverEmpty && serverAfter.length === 3,
		`plan inserts=${plan?.inserts.length}, server before=${serverEmpty ? 0 : 'n>0'}, after=${serverAfter.length}`,
	);

	// ── Proof 5: different-field offline edits compose ────────────────────────
	console.log('\nPhase 3: two clients, field-level merge');
	const pageB = await openApp(contextB, { profile: 'B' });
	await demoEval(pageB, `window.demo.signIn('braden', 'keep')`);
	await settle(1500);
	const listB = await titles(pageB);
	if (listB.size !== 3) console.warn(`  (B bootstrap saw ${listB.size} rows)`);

	await demoEval(pageA, 'window.demo.setOnline(false)');
	await demoEval(pageB, 'window.demo.setOnline(false)');
	await demoEval(pageA, `window.demo.patchCell('${id2}', 'title', 'title-from-A')`);
	await demoEval(pageB, `window.demo.patchCell('${id2}', 'subtitle', 'subtitle-from-B')`);
	await demoEval(pageA, 'window.demo.setOnline(true)');
	await settle(1200);
	await demoEval(pageB, 'window.demo.setOnline(true)');
	await settle(1500);
	const rowA = (await titles(pageA)).get(id2);
	const rowB = (await titles(pageB)).get(id2);
	record(
		5,
		'different-field offline edits both survive',
		rowA?.title === 'title-from-A' &&
			rowA?.subtitle === 'subtitle-from-B' &&
			rowB?.title === 'title-from-A' &&
			rowB?.subtitle === 'subtitle-from-B',
		`A sees ${JSON.stringify({ t: rowA?.title, s: rowA?.subtitle })}, B sees ${JSON.stringify({ t: rowB?.title, s: rowB?.subtitle })}`,
	);

	// ── Proof 6: same-field conflict → server acceptance order ───────────────
	await demoEval(pageA, 'window.demo.setOnline(false)');
	await demoEval(pageB, 'window.demo.setOnline(false)');
	// Discriminating interleaving: B edits FIRST in wall-clock time, A edits
	// 300ms LATER — then A pushes first and B pushes second. Wall-clock LWW
	// would pick A (newer timestamp); acceptance order picks B (accepted
	// later). Only a B win proves the server log is the authority.
	await demoEval(pageB, `window.demo.patchCell('${id3}', 'title', 'same-field-B')`);
	await settle(300);
	await demoEval(pageA, `window.demo.patchCell('${id3}', 'title', 'same-field-A')`);
	await demoEval(pageA, 'window.demo.setOnline(true)');
	await settle(1200);
	await demoEval(pageB, 'window.demo.setOnline(true)');
	await settle(1500);
	const winnerA = (await titles(pageA)).get(id3)?.title;
	const winnerB = (await titles(pageB)).get(id3)?.title;
	const serverRow3 = (await serverNotes()).find((row) => row.id === id3);
	record(
		6,
		'same-field conflict resolved by server acceptance order',
		winnerA === 'same-field-B' && winnerB === 'same-field-B' && serverRow3?.title === 'same-field-B',
		`A=${winnerA}, B=${winnerB}, server=${serverRow3?.title}`,
	);

	// ── Proof 7: old client cannot erase unknown newer field ─────────────────
	console.log('\nPhase 4: mixed versions');
	const pageC = await openApp(contextC, { profile: 'C', appver: '1' });
	await demoEval(pageC, `window.demo.signIn('braden', 'keep')`);
	await settle(1500);
	const rowC = (await titles(pageC)).get(id2);
	const carriesUnknown = JSON.parse(String(rowC?.extra ?? '{}'));
	await demoEval(pageC, `window.demo.patchCell('${id2}', 'title', 'edited-by-v1')`);
	await settle(1500);
	const rowAafterV1 = (await titles(pageA)).get(id2);
	record(
		7,
		'old client edits known field without erasing unknown newer field',
		carriesUnknown.subtitle === 'subtitle-from-B' &&
			rowAafterV1?.title === 'edited-by-v1' &&
			rowAafterV1?.subtitle === 'subtitle-from-B',
		`v1 carries extra=${JSON.stringify(carriesUnknown)}, v2 after v1 edit: title=${rowAafterV1?.title}, subtitle=${rowAafterV1?.subtitle}`,
	);

	// ── Proof 8: remote changes arrive without polling ────────────────────────
	console.log('\nPhase 5: push-driven reactivity');
	serverRequests.length = 0;
	await settle(3000);
	const idleRequests = serverRequests.length;
	await demoEval(pageB, `window.demo.createNote('poked-note')`);
	await pageA.waitForFunction(
		`document.getElementById('notes').textContent.includes('poked-note')`,
		undefined,
		{ timeout: 5000 },
	);
	record(
		8,
		'remote change updates reactive query, zero idle polling',
		idleRequests === 0,
		`idle requests over 3s=${idleRequests}, poked-note appeared in A's DOM`,
	);

	// ── Proof 9: Yjs bodies merge independently, load lazily ─────────────────
	console.log('\nPhase 6: lazy Yjs bodies');
	await demoEval(pageA, `window.demo.openNoteBody('${id1}')`);
	const framesOnFirstOpen = await demoEval<number>(pageA, 'window.demo.bodyFrameCount()');
	await demoEval(pageA, 'window.demo.setOnline(false)');
	await demoEval(pageB, `window.demo.openNoteBody('${id1}')`);
	await demoEval(pageB, 'window.demo.setOnline(false)');
	await demoEval(pageA, `window.demo.appendBody('alpha-')`);
	await demoEval(pageB, `window.demo.appendBody('beta-')`);
	await demoEval(pageA, 'window.demo.setOnline(true)');
	await settle(1200);
	await demoEval(pageB, 'window.demo.setOnline(true)');
	await settle(1500);
	// Reopen to read the merged, durable state.
	await demoEval(pageA, `window.demo.openNoteBody('${id1}')`);
	await demoEval(pageB, `window.demo.openNoteBody('${id1}')`);
	const bodyA = await demoEval<string>(pageA, 'window.demo.bodyText()');
	const bodyB = await demoEval<string>(pageB, 'window.demo.bodyText()');
	record(
		9,
		'Yjs bodies lazily loaded and independently mergeable',
		framesOnFirstOpen === 0 &&
			bodyA === bodyB &&
			bodyA.includes('alpha-') &&
			bodyA.includes('beta-'),
		`frames on first open=${framesOnFirstOpen}, merged='${bodyA}'`,
	);

	// ── Proof 10: dead server never blocks local reads/writes ────────────────
	console.log('\nPhase 7: server failure');
	server.kill();
	await server.exited;
	server = null;
	await demoEval(pageA, `window.demo.createNote('written-while-server-dead')`);
	await settle(500);
	const listDead = await titles(pageA);
	const wroteWhileDead = [...listDead.values()].some(
		(row) => row.title === 'written-while-server-dead',
	);
	server = startServer(['--mode', 'hosted']);
	await waitForServer(SERVER);
	await demoEval(pageA, 'window.demo.setOnline(false)');
	await demoEval(pageA, 'window.demo.setOnline(true)');
	await settle(1500);
	const serverRecovered = (await serverNotes()).some(
		(row) => row.title === 'written-while-server-dead',
	);
	record(
		10,
		'failed server never prevents local reads/writes; drains on recovery',
		wroteWhileDead && serverRecovered,
		`local write ok=${wroteWhileDead}, drained after restart=${serverRecovered}`,
	);

	// ── Proof 11: schema mismatch pauses sync, local stays usable ────────────
	console.log('\nPhase 8: schema-version mismatch');
	const pageD = await openApp(contextD, { profile: 'D', schemamajor: '1' });
	await demoEval(pageD, `window.demo.signIn('braden', 'keep')`);
	await settle(1200);
	await demoEval(pageD, `window.demo.createNote('written-under-mismatch')`);
	await demoEval(pageD, 'window.demo.syncNow()');
	await settle(500);
	const statusD = await demoEval<string>(pageD, 'window.demo.syncStatus()');
	const listD = await titles(pageD);
	const localUsable = [...listD.values()].some(
		(row) => row.title === 'written-under-mismatch',
	);
	const leakedToServer = (await serverNotes()).some(
		(row) => row.title === 'written-under-mismatch',
	);
	record(
		11,
		'schema mismatch pauses unsafe sync without breaking local db',
		statusD === 'schema-mismatch' && localUsable && !leakedToServer,
		`status=${statusD}, local write ok=${localUsable}, leaked=${leakedToServer}`,
	);

	// ── Proof 12: hosted and self-hosted use the same client protocol ────────
	console.log('\nPhase 9: self-host topology');
	selfhost = startServer(['--mode', 'selfhost', '--port', '8789']);
	await waitForServer(SELFHOST);
	const pageE = await openApp(contextE, {
		profile: 'E',
		server: SELFHOST,
	});
	await demoEval(pageE, `window.demo.signIn('any-token-at-all', 'keep')`);
	await settle(1200);
	await demoEval(pageE, `window.demo.createNote('selfhost-note')`);
	await settle(1500);
	const selfhostRows = await serverNotes(SELFHOST, 'different-token');
	record(
		12,
		'hosted and self-hosted expose the same client protocol',
		selfhostRows.some((row) => row.title === 'selfhost-note'),
		`selfhost instance sees ${selfhostRows.length} note(s) regardless of bearer`,
	);
} finally {
	await browser.close();
	server?.kill();
	selfhost?.kill();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} proofs passed`);
if (passed < results.length) process.exit(1);
