const status = document.querySelector('#status');

function callWorker(message) {
	const worker = new Worker('/worker.js', { type: 'module' });
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			worker.terminate();
			reject(new Error(`Worker timed out during ${message.kind}`));
		}, 30_000);
		worker.onmessage = (event) => {
			clearTimeout(timeout);
			worker.terminate();
			if (event.data.ok) resolve(event.data.value);
			else reject(new Error(event.data.error));
		};
		worker.onerror = (event) => {
			clearTimeout(timeout);
			worker.terminate();
			reject(new Error(event.message));
		};
		worker.postMessage(message);
	});
}

function percentile(values, fraction) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[
		Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
	];
}

async function removeScratchDatabase(databaseName) {
	const root = await navigator.storage.getDirectory();
	for (const name of [databaseName, `${databaseName}-journal`]) {
		try {
			await root.removeEntry(name);
		} catch (cause) {
			if (cause instanceof DOMException && cause.name === 'NotFoundError')
				continue;
			throw cause;
		}
	}
}

globalThis.preparePrototypeDatabase = ({ databaseName, mode }) =>
	callWorker({
		kind: 'prepare',
		databasePath: `/${databaseName}`,
		mode,
	});

globalThis.commitPrototypeMarker = ({
	databaseName,
	mode,
	marker,
	payloadBytes = 8192,
}) =>
	callWorker({
		kind: 'commit',
		databasePath: `/${databaseName}`,
		mode,
		marker,
		payloadBytes,
	});

globalThis.verifyPrototypeMarker = ({ databaseName, mode, marker }) =>
	callWorker({
		kind: 'verify',
		databasePath: `/${databaseName}`,
		mode,
		marker,
	});

globalThis.removePrototypeDatabase = removeScratchDatabase;

async function runMode({ mode, iterations, payloadBytes, runId }) {
	const databaseName = `prototype-opfs-sync-${runId}-${mode.toLowerCase()}.sqlite3`;
	const databasePath = `/${databaseName}`;
	const prepared = await callWorker({ kind: 'prepare', databasePath, mode });
	const benchmark = await callWorker({
		kind: 'benchmark',
		databasePath,
		mode,
		iterations,
		payloadBytes,
	});
	const recovery = [];
	for (let index = 0; index < iterations; index += 1) {
		const marker = 1_000_000 + index;
		const committed = await callWorker({
			kind: 'commit',
			databasePath,
			mode,
			marker,
			payloadBytes,
		});
		const reopened = await callWorker({
			kind: 'verify',
			databasePath,
			mode,
			marker,
		});
		recovery.push({
			marker,
			commitMs: committed.commitMs,
			present: reopened.present,
			integrity: reopened.integrity,
		});
	}
	await removeScratchDatabase(databaseName);
	const durations = benchmark.commitMs;
	return {
		mode,
		journalMode: prepared.journalMode,
		synchronous: prepared.synchronous,
		iterations,
		payloadBytes,
		p50Ms: percentile(durations, 0.5),
		p95Ms: percentile(durations, 0.95),
		p99Ms: percentile(durations, 0.99),
		meanMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
		recovered: recovery.filter(
			(result) => result.present && result.integrity === 'ok',
		).length,
	};
}

globalThis.runExperiment = async function runExperiment({
	iterations = 30,
	payloadBytes = 8192,
	extraFirst = false,
} = {}) {
	const runId = `${Date.now()}-${crypto.randomUUID()}`;
	const modes = extraFirst ? ['EXTRA', 'FULL'] : ['FULL', 'EXTRA'];
	const results = {};
	for (const mode of modes) {
		status.textContent = `Running ${mode}...`;
		results[mode.toLowerCase()] = await runMode({
			mode,
			iterations,
			payloadBytes,
			runId,
		});
	}
	const result = { full: results.full, extra: results.extra };
	status.textContent = JSON.stringify(result, null, 2);
	return result;
};
