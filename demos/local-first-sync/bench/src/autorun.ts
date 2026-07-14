/**
 * Manual device harness: open a bench page with `?autorun&rows=10000` on any
 * browser (Safari/iPhone included) and the standard phase sequence runs,
 * rendering results into the page. This is the fallback where Playwright
 * automation is unavailable.
 */

export async function maybeAutorun() {
	const params = new URLSearchParams(location.search);
	if (!params.has('autorun')) return;
	const rows = Number(params.get('rows') ?? '10000');
	const churn = Math.floor(rows * 0.4);

	const out = document.createElement('pre');
	out.style.cssText = 'font-size:12px;white-space:pre-wrap';
	document.body.append(out);
	const log = (line: string) => {
		out.textContent += `${line}\n`;
	};

	const bench = window.bench;
	await window.benchReady;
	log(`engine=${bench.engine} rows=${rows} churn=${churn}`);
	log(`ua=${navigator.userAgent}`);

	// Phase A: seed fresh, then reload with ?phase=b to measure cold open.
	const phase = params.get('phase') ?? 'a';
	if (phase === 'a') {
		await bench.reset();
		const seed = await bench.seed(rows);
		log(
			`seed: insert ${seed.insertMs.toFixed(0)}ms persist ${seed.persistMs.toFixed(0)}ms`,
		);
		log('reloading for cold-open phase…');
		params.set('phase', 'b');
		location.search = params.toString();
		return;
	}

	// Phase B: cold open + reads + writes on the persisted database.
	const hydrate = await bench.hydrate();
	log(
		`cold open: ${hydrate.hydrateMs.toFixed(0)}ms (${hydrate.rowCount} rows)`,
	);
	log(`settled memory: ${JSON.stringify(await bench.memory())}`);
	log(`query100: ${JSON.stringify(await bench.query100())}`);
	log(`search: ${JSON.stringify(await bench.search('needle'))}`);
	log(`editOne: ${JSON.stringify(await bench.editOne(42))}`);
	log(`remoteApply(500): ${JSON.stringify(await bench.remoteApply(500))}`);
	log(`churn(${churn}): ${JSON.stringify(await bench.churn(churn))}`);
	log(`memory after churn: ${JSON.stringify(await bench.memory())}`);
	log(`persist size: ${JSON.stringify(await bench.persistSize())}`);
	log('done. (reload without ?phase=b to reseed)');
}
