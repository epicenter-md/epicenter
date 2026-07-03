/**
 * Headless, dependency-free smoke test for the Local Mail write path.
 *
 * One shot, no browser: it stands up the safe stack (throwaway mirror copy with
 * forged creds + mock Gmail + `local-mail up`), exchanges a session bearer,
 * fires ONE real triage write through `/api/messages/modify`, and proves the two
 * things the manual browser loop does:
 *   1. the write reached the mock (a matching line lands in the modify log), and
 *   2. the REAL mirror's durable state is byte-identical before and after.
 *
 * It tears the mock and app down on the way out and exits non-zero on any
 * failure, so it doubles as a regression guard a future developer can just run:
 *
 *   bun run apps/local-mail/test-support/smoke.ts
 *
 * For the browser-only affordances (undo toast, catching-up chip, shortcuts
 * overlay, keyboard dispatch) use ./browser-smoke.ts. Both are LOCAL tooling,
 * deliberately not wired into CI: they need a real connected mirror to copy from.
 */
import { bootHarness, fingerprintReal, readModifyLog } from './boot.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
	// Fingerprint the real mirror BEFORE anything runs.
	const before = await fingerprintReal();

	const harness = await bootHarness({ fold: true });
	try {
		// Exchange the single-use bootstrap for a session bearer.
		const sessionRes = await fetch(`${harness.appOrigin}/api/session`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: harness.bootstrapToken }),
		});
		const bearer = ((await sessionRes.json()) as { token?: string }).token;
		if (!bearer) throw new Error('session exchange returned no bearer');
		const auth = {
			authorization: `Bearer ${bearer}`,
			'content-type': 'application/json',
		};

		// Pick a message and a real label change. Prefer archiving an inbox
		// message; fall back to toggling STARRED on any message.
		const pick = async (query: string) =>
			(
				(await (
					await fetch(`${harness.appOrigin}/api/messages?${query}`, {
						headers: auth,
					})
				).json()) as { messages: { id: string; labelIds: string[] }[] }
			).messages[0];
		let target = await pick('label=INBOX&limit=1');
		let addLabels: string[] = [];
		let removeLabels: string[] = ['INBOX'];
		if (!target) {
			target = await pick('limit=1');
			if (!target) throw new Error('the mirror copy has no messages to modify');
			const starred = target.labelIds.includes('STARRED');
			addLabels = starred ? [] : ['STARRED'];
			removeLabels = starred ? ['STARRED'] : [];
		}

		// Fire the write through the exact route the SPA uses.
		const modifyRes = await fetch(`${harness.appOrigin}/api/messages/modify`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ ids: [target.id], addLabels, removeLabels }),
		});
		const modifyBody = await modifyRes.json();
		if (!modifyRes.ok)
			throw new Error(`modify failed: ${JSON.stringify(modifyBody)}`);

		// Prove the write reached the mock.
		await sleep(200);
		const logged = readModifyLog(harness.mockLog).find(
			(e) => e.id === target.id,
		);
		if (!logged) throw new Error(`no modify for ${target.id} in the mock log`);

		// Prove the real mirror is untouched.
		const after = await fingerprintReal();
		if (after !== before) {
			throw new Error(
				`REAL mirror changed!\nbefore:\n${before}\nafter:\n${after}`,
			);
		}

		console.log('SMOKE PASS');
		console.log(
			`  wrote add=${JSON.stringify(addLabels)} remove=${JSON.stringify(removeLabels)} to ${target.id}`,
		);
		console.log(`  mock logged: ${JSON.stringify(logged)}`);
		console.log(
			`  real mirror fingerprint unchanged (${before.split('\n').length} files)`,
		);
	} finally {
		harness.teardown();
	}
}

try {
	await main();
	process.exit(0);
} catch (err) {
	console.error(
		`SMOKE FAIL: ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exit(1);
}
