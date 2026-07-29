#!/usr/bin/env bun

/**
 * @fileoverview Prove `@epicenter/app` works for someone who is not us.
 *
 * The claim this package makes is that an app author installs it and imports
 * it, with no aliases, no resolve conditions, no import map, and no build
 * configuration. Nothing inside this repo can test that claim: a workspace
 * import resolves to `src/` and would pass while the published package was
 * broken.
 *
 * So this builds the package, packs it exactly as `bun publish` would, and
 * takes the tarball somewhere else. The consumer fixture is copied to a
 * temporary directory outside the repository, so it cannot inherit the
 * workspace, the root `tsconfig`, the lockfile, or the installed node_modules,
 * and there the package is installed from the tarball and built with an
 * ordinary TypeScript and Vite setup.
 *
 * Run: `bun run verify:consumer` from `packages/app`.
 *
 * Everything this builds is thrown away, because the claim is about the build
 * and not about the output. `--out <dir>` is the exception: it keeps the built
 * `dist` at a path the caller names, so the fixture can be admitted as a real
 * app and driven against real hardware. The caller owns that directory; the
 * script refuses to write into one that already exists.
 */

import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageDir = join(import.meta.dir, '..');
const fixtureDir = join(packageDir, 'test-fixtures', 'consumer');

function usage(): never {
	console.error(
		'Usage: bun run scripts/verify-external-consumer.ts [--out <dir>]',
	);
	process.exit(1);
}

/** Whether anything at all is already at `path`. */
async function exists(path: string) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

const args = Bun.argv.slice(2);
const outFlag = args.indexOf('--out');
const outArg = outFlag === -1 ? undefined : args.splice(outFlag, 2)[1];
if (args.length > 0 || (outFlag !== -1 && outArg === undefined)) usage();

const outDir = outArg === undefined ? undefined : resolve(outArg);
// Checked before the build rather than after it, so a caller who pointed at an
// occupied path finds out now instead of two minutes from now.
if (outDir !== undefined && (await exists(outDir))) {
	console.error(
		`FAILED: ${outDir} already exists. --out writes one fresh directory; removing an old one is the caller's decision, not this script's.`,
	);
	process.exit(1);
}

/**
 * Everything a published tarball is allowed to contain.
 *
 * `src` ships because `dist` ships source maps, and a map that resolves to
 * nothing is worse than no map. It is not reachable by import: `exports` names
 * one entry point, which is what stops a consumer deep-importing it and
 * inheriting our compiler settings after all. Tests do not ship.
 */
const ALLOWED_ENTRIES = [
	/^package\/package\.json$/,
	/^package\/README\.md$/,
	/^package\/LICENSE$/,
	/^package\/dist\/[\w./-]+\.(js|d\.ts|map)$/,
	/^package\/src\/[\w./-]+\.ts$/,
];
const FORBIDDEN_ENTRIES = [/\.test\.ts$/, /^package\/scripts\//, /tsconfig/];

async function run(command: string[], cwd: string, label: string) {
	const proc = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	if (proc.exitCode !== 0) {
		console.error(
			`FAILED: ${label}\n$ ${command.join(' ')}\n${stdout}${stderr}`,
		);
		process.exit(1);
	}
	console.log(`  ok  ${label}`);
	return stdout;
}

const workspace = await mkdtemp(join(tmpdir(), 'epicenter-app-consumer-'));
try {
	console.log('Building and packing @epicenter/app');
	await run(['bun', 'run', 'build'], packageDir, 'build');
	await run(
		['bun', 'pm', 'pack', '--destination', workspace],
		packageDir,
		'pack',
	);

	const tarball = (await readdir(workspace)).find((name) =>
		name.endsWith('.tgz'),
	);
	if (!tarball) {
		console.error('FAILED: bun pm pack produced no tarball');
		process.exit(1);
	}
	const tarballPath = join(workspace, tarball);

	console.log(`\nInspecting ${tarball}`);
	const listing = await run(
		['tar', '-tzf', tarballPath],
		workspace,
		'list contents',
	);
	const entries = listing
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.endsWith('/'));
	const unexpected = entries.filter(
		(entry) =>
			!ALLOWED_ENTRIES.some((allowed) => allowed.test(entry)) ||
			FORBIDDEN_ENTRIES.some((forbidden) => forbidden.test(entry)),
	);
	if (unexpected.length > 0) {
		console.error(
			`FAILED: the tarball carries files it should not ship:\n  ${unexpected.join('\n  ')}`,
		);
		process.exit(1);
	}
	for (const entry of entries) console.log(`      ${entry}`);
	console.log(`  ok  ${entries.length} files, all expected`);

	// The publish gate's own check, run here too: bun resolves `catalog:` and
	// `workspace:` at pack time, and a residual one is a manifest that 404s on
	// a clean install.
	const manifest = await run(
		['tar', '-xzOf', tarballPath, 'package/package.json'],
		workspace,
		'read packed manifest',
	);
	for (const protocol of ['catalog:', 'workspace:']) {
		if (manifest.includes(protocol)) {
			console.error(`FAILED: packed manifest still contains ${protocol}`);
			process.exit(1);
		}
	}
	const parsed = JSON.parse(manifest) as {
		dependencies?: Record<string, string>;
	};
	console.log(
		`  ok  resolved dependencies: ${JSON.stringify(parsed.dependencies)}`,
	);

	console.log(`\nBuilding a foreign consumer in ${workspace}`);
	const consumer = join(workspace, 'consumer');
	await cp(fixtureDir, consumer, { recursive: true });
	await run(['bun', 'install'], consumer, 'install fixture toolchain');
	await run(['bun', 'add', tarballPath], consumer, 'install the tarball');
	await run(['bun', 'run', 'typecheck'], consumer, 'tsc --noEmit');
	await run(['bun', 'run', 'build'], consumer, 'vite build');

	// A build that produced nothing would pass every step above.
	const assets = await readdir(join(consumer, 'dist', 'assets'));
	const bundle = assets.find((name) => name.endsWith('.js'));
	if (!bundle) {
		console.error('FAILED: vite produced no JavaScript bundle');
		process.exit(1);
	}
	const bundled = await Bun.file(
		join(consumer, 'dist', 'assets', bundle),
	).text();
	for (const marker of ['start_recording', 'transcribe_recording']) {
		if (!bundled.includes(marker)) {
			console.error(`FAILED: the bundle does not contain ${marker}`);
			process.exit(1);
		}
	}
	console.log(`  ok  bundle ${bundle} carries the client`);

	// Epicenter serves an admitted app below `/apps/<id>/` (ADR-0179), and the
	// app does not know its id at build time. Vite's default base of `/` emits
	// `/assets/index-*.js`, which resolves against the origin root and 404s for
	// every app but whichever one happens to be mounted there. The fixture sets
	// a relative base; this is what notices if that regresses.
	const indexHtml = await Bun.file(join(consumer, 'dist', 'index.html')).text();
	const references = [...indexHtml.matchAll(/\b(?:src|href)="([^"]*)"/g)].map(
		([, url]) => url,
	);
	const rootAbsolute = references.filter((url) => url.startsWith('/'));
	if (rootAbsolute.length > 0) {
		console.error(
			`FAILED: index.html references root-absolute assets, which cannot resolve below /apps/<id>/:\n  ${rootAbsolute.join('\n  ')}`,
		);
		process.exit(1);
	}
	if (!references.some((url) => url.endsWith(bundle))) {
		console.error(
			`FAILED: index.html does not reference ${bundle}, so the built document loads nothing.`,
		);
		process.exit(1);
	}
	console.log(`  ok  index.html loads ${bundle} by a relative path`);

	console.log('\nA foreign consumer builds against the packed package.');

	// The only output that outlives the run, and only when asked for. Copied
	// after every assertion above, so an exported directory is one that passed.
	if (outDir !== undefined) {
		await cp(join(consumer, 'dist'), outDir, { recursive: true });
		console.log(`\nExported the built app to ${outDir}`);
	}
} finally {
	await rm(workspace, { recursive: true, force: true });
}
