#!/usr/bin/env node

/**
 * @fileoverview Publish the public @epicenter/* packages to npm with bun.
 *
 * Replaces `changeset publish`. We pack and upload with `bun publish` because
 * it resolves bun-only dependency protocols (`catalog:`, `workspace:*`) at pack
 * time, which the npm-based `changeset publish` does not. That gap is what
 * shipped the broken @epicenter/*@0.1.0 manifests (their published deps still
 * read `catalog:` / `workspace:*`, so a clean `npm install` 404s).
 *
 * Division of labor: `changeset version` still owns version math and
 * changelogs; this script only verifies, uploads, and tags. The repo `release`
 * script chains them: `changeset version && bun run scripts/publish-packages.ts`.
 *
 * Flow:
 *   1. build the compiled installed-app SDK closure in dependency order
 *   2. discover every packages/* package.json that is not `private`
 *   3. GATE: pack each with `bun pm pack` and assert the packed manifest has no
 *      unresolved `catalog:` / `workspace:` strings AND no dependency on a
 *      private @epicenter/* package (bun resolves workspace:* to the concrete
 *      version of a private package, which still 404s on install). Always runs
 *      first, so a dirty manifest aborts before any upload.
 *   4. (real run only) skip any name@version already on the npm registry, then
 *      `bun publish --access public` each remaining package and create a local
 *      `name@version` git tag. Pushing tags is left to the operator (matching
 *      bump-version.ts: this script performs no network git operations).
 *
 * Usage:
 *   bun run scripts/publish-packages.ts             # gate, then publish + tag
 *   bun run scripts/publish-packages.ts --dry-run   # gate only, never uploads
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';

type Package = { dir: string; name: string; version: string };

const root = process.cwd();
const dryRun = process.argv.includes('--dry-run');

async function buildCompiledAppSdk(): Promise<void> {
	const build = Bun.spawn(['bun', 'run', 'build:app-sdk'], {
		cwd: root,
		stdout: 'inherit',
		stderr: 'inherit',
	});
	await build.exited;
	if (build.exitCode !== 0) {
		console.error('compiled app SDK build failed');
		process.exit(1);
	}
}

/** Discover every publishable (non-private) package under packages/. */
async function discoverPackages(): Promise<Package[]> {
	const packages: Package[] = [];
	const glob = new Glob('packages/*/package.json');
	for await (const match of glob.scan({ cwd: root })) {
		const pkgPath = join(root, match);
		const pkg = JSON.parse(await Bun.file(pkgPath).text()) as {
			name?: string;
			version?: string;
			private?: boolean;
		};
		if (pkg.private) continue;
		if (!pkg.name || !pkg.version) {
			console.error(`${match} is public but missing a name or version`);
			process.exit(1);
		}
		packages.push({
			dir: join(pkgPath, '..'),
			name: pkg.name,
			version: pkg.version,
		});
	}
	return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pack a package with `bun pm pack` and return every reason its tarball is
 * unsafe to publish. An empty array means the manifest is clean. Two checks:
 *
 *   1. No unresolved bun-only protocol string (`catalog:`, `workspace:`). bun
 *      should resolve these at pack time; a residual means it could not.
 *   2. No dependency on an @epicenter/* package outside `publishable`. bun
 *      happily resolves `workspace:*` to the concrete version of a PRIVATE
 *      package, producing a manifest that 404s on a clean install (this is how
 *      cli -> auth and workspace -> util slip past the string check).
 */
async function findPublishBlockers(
	pkg: Package,
	publishable: Set<string>,
): Promise<string[]> {
	const dest = await mkdtemp(join(tmpdir(), 'epi-pack-'));
	try {
		const pack = Bun.spawn(['bun', 'pm', 'pack', '--destination', dest], {
			cwd: pkg.dir,
			stdout: 'ignore',
			stderr: 'inherit',
		});
		await pack.exited;
		if (pack.exitCode !== 0) {
			console.error(`bun pm pack failed for ${pkg.name}`);
			process.exit(1);
		}

		const tgzGlob = new Glob('*.tgz');
		let tgz: string | undefined;
		for await (const match of tgzGlob.scan({ cwd: dest })) {
			tgz = join(dest, match);
			break;
		}
		if (!tgz) {
			console.error(`no tarball produced for ${pkg.name}`);
			process.exit(1);
		}

		const extract = Bun.spawn(['tar', '-xzOf', tgz, 'package/package.json'], {
			stdout: 'pipe',
			stderr: 'inherit',
		});
		const manifest = await new Response(extract.stdout).text();
		await extract.exited;

		const blockers: string[] = [];
		for (const protocol of ['catalog:', 'workspace:']) {
			if (manifest.includes(protocol)) {
				blockers.push(`unresolved ${protocol}`);
			}
		}

		const parsed = JSON.parse(manifest) as {
			dependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		};
		for (const group of [parsed.dependencies, parsed.peerDependencies]) {
			for (const dep of Object.keys(group ?? {})) {
				if (dep.startsWith('@epicenter/') && !publishable.has(dep)) {
					blockers.push(`depends on unpublishable ${dep}`);
				}
			}
		}

		return blockers;
	} finally {
		await rm(dest, { recursive: true, force: true });
	}
}

/** True when name@version is already on the npm registry (idempotent skip). */
async function isAlreadyPublished(pkg: Package): Promise<boolean> {
	const url = `https://registry.npmjs.org/${pkg.name.replace('/', '%2F')}`;
	const res = await fetch(url);
	if (res.status === 404) return false;
	if (!res.ok) {
		console.error(`registry query for ${pkg.name} failed: HTTP ${res.status}`);
		process.exit(1);
	}
	const data = (await res.json()) as { versions?: Record<string, unknown> };
	return Boolean(data.versions?.[pkg.version]);
}

await buildCompiledAppSdk();

const packages = await discoverPackages();
if (packages.length === 0) {
	console.error('No publishable packages found under packages/.');
	process.exit(1);
}

console.log(
	`\n${dryRun ? 'Verifying' : 'Releasing'} ${packages.length} package(s):\n`,
);

// Gate: no tarball with an unresolved protocol string or an unpublishable
// @epicenter/* dependency ever reaches the registry.
const publishableNames = new Set(packages.map((pkg) => pkg.name));
let dirty = 0;
for (const pkg of packages) {
	const blockers = await findPublishBlockers(pkg, publishableNames);
	if (blockers.length > 0) {
		dirty++;
		console.error(`  ✗ ${pkg.name}@${pkg.version}: ${blockers.join('; ')}`);
	} else {
		console.log(`  ✓ ${pkg.name}@${pkg.version}: clean manifest`);
	}
}
if (dirty > 0) {
	console.error(
		`\n${dirty} package(s) are not safe to publish. Aborting before any upload.`,
	);
	process.exit(1);
}

if (dryRun) {
	console.log('\nAll packed manifests are clean. Safe to publish.');
	process.exit(0);
}

// Real run: publish each not-yet-published version, then tag it locally.
console.log('');
const published: string[] = [];
for (const pkg of packages) {
	if (await isAlreadyPublished(pkg)) {
		console.log(`skip ${pkg.name}@${pkg.version} (already on npm)`);
		continue;
	}

	console.log(`publishing ${pkg.name}@${pkg.version}...`);
	const publish = Bun.spawn(['bun', 'publish', '--access', 'public'], {
		cwd: pkg.dir,
		stdout: 'inherit',
		stderr: 'inherit',
	});
	await publish.exited;
	if (publish.exitCode !== 0) {
		console.error(`publish failed for ${pkg.name}@${pkg.version}`);
		process.exit(1);
	}

	const tag = `${pkg.name}@${pkg.version}`;
	const tagProc = Bun.spawn(['git', 'tag', tag], {
		cwd: root,
		stdout: 'inherit',
		stderr: 'inherit',
	});
	await tagProc.exited;
	published.push(tag);
}

if (published.length === 0) {
	console.log('\nNothing to publish: every version is already on npm.');
} else {
	console.log(`\nPublished and tagged ${published.length} package(s):`);
	for (const tag of published) console.log(`  ${tag}`);
	console.log('\nPush the tags when ready: git push --tags');
}
