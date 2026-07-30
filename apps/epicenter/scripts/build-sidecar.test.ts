/**
 * Epicenter Bun Host Packaging Tests
 *
 * Verifies the compiled Bun child runs without a system Bun on PATH, accepts
 * only the fixed production boot contract, finds packaged Home and Whispering
 * assets through the Rust-supplied resource path, and exits when the parent
 * pipe closes.
 */

import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	PRODUCTION_PORT,
	type ReadyFrame,
	SIDECAR_PROTOCOL_VERSION,
} from '../src/sidecar-runtime.ts';

const appDir = join(import.meta.dir, '..');

async function hostTargetTriple(): Promise<string> {
	const process = Bun.spawn(['rustc', '-vV'], { stdout: 'pipe' });
	const output = await new Response(process.stdout).text();
	expect(await process.exited).toBe(0);
	const host = output
		.split('\n')
		.find((line) => line.startsWith('host: '))
		?.slice('host: '.length)
		.trim();
	if (!host) throw new Error('rustc did not report a host triple');
	return host;
}

async function readReady(
	stdout: ReadableStream<Uint8Array>,
	stderr: ReadableStream<Uint8Array>,
): Promise<ReadyFrame> {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (value) buffer += decoder.decode(value, { stream: true });
			const newline = buffer.indexOf('\n');
			if (newline !== -1) {
				return JSON.parse(buffer.slice(0, newline)) as ReadyFrame;
			}
			if (done) {
				const detail = (await new Response(stderr).text()).trim();
				throw new Error(
					detail.length > 0
						? `compiled host exited before readiness: ${detail}`
						: 'compiled host exited before readiness',
				);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

test('compiled production host serves packaged apps and exits on parent EOF', async () => {
	const build = Bun.spawn(['bun', 'run', 'build:desktop'], {
		cwd: appDir,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if ((await build.exited) !== 0) {
		throw new Error(await new Response(build.stderr).text());
	}

	const triple = await hostTargetTriple();
	const binary = join(
		appDir,
		'src-tauri',
		'binaries',
		`epicenter-host-${triple}`,
	);
	const dataDir = mkdtempSync(join(tmpdir(), 'epicenter-compiled-host-'));
	const sidecar = Bun.spawn([binary, '--runtime-mode=production'], {
		env: {
			EPICENTER_DEV_PORT: '49152',
			EPICENTER_DATA_DIR: dataDir,
			EPICENTER_APPS_DIST: join(appDir, 'dist'),
			EPICENTER_INFERENCE_URL: 'http://127.0.0.1:1/v1',
			EPICENTER_INFERENCE_MODEL: 'unused-model',
			PATH: '',
			PORT: '49153',
		},
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	try {
		sidecar.stdin.write(
			`${JSON.stringify({
				type: 'boot',
				protocolVersion: SIDECAR_PROTOCOL_VERSION,
				token: 'compiled_test_token',
				port: PRODUCTION_PORT,
				authCell: null,
			})}\n`,
		);
		await sidecar.stdin.flush();
		expect(await readReady(sidecar.stdout, sidecar.stderr)).toEqual({
			type: 'ready',
			protocolVersion: SIDECAR_PROTOCOL_VERSION,
			port: PRODUCTION_PORT,
		});
		const origin = `http://127.0.0.1:${PRODUCTION_PORT}`;
		const bootstrap = await fetch(`${origin}/_epicenter/bootstrap`, {
			method: 'POST',
			headers: {
				authorization: 'Bearer compiled_test_token',
				origin,
			},
		});
		expect(bootstrap.status).toBe(204);
		const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
		expect(cookie).toBeDefined();
		const session = { headers: { cookie: cookie ?? '' } };

		const home = await fetch(`${origin}/apps/home/`, session);
		expect(home.status).toBe(200);
		expect(await home.text()).toContain('<title>Home</title>');
		const whispering = await fetch(`${origin}/apps/whispering/`, session);
		expect(whispering.status).toBe(200);
		const whisperingPage = await whispering.text();
		expect(whisperingPage).toContain('<title>Whispering</title>');
		const entryPath = whisperingPage.match(
			/\/apps\/whispering\/_app\/[^" ]+\.js/,
		)?.[0];
		expect(entryPath).toBeDefined();
		const entry = await fetch(`${origin}${entryPath ?? ''}`, session);
		expect(entry.status).toBe(200);
		expect(entry.headers.get('content-type')).toContain('text/javascript');
		const vad = await fetch(
			`${origin}/apps/whispering/vad/silero_vad_v5.onnx`,
			session,
		);
		expect(vad.status).toBe(200);
		expect((await vad.arrayBuffer()).byteLength).toBeGreaterThan(1_000);

		sidecar.stdin.end();
		expect(await sidecar.exited).toBe(0);

		const replacement = Bun.serve({
			hostname: '127.0.0.1',
			port: PRODUCTION_PORT,
			fetch: () => new Response(),
		});
		expect(replacement.port).toBe(PRODUCTION_PORT);
		await replacement.stop(true);
	} finally {
		sidecar.kill();
	}
}, 120_000);
