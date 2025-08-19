import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileStore, FsSnapshot } from '../core/fs';

async function ensureDir(filePath: string) {
	await fs.mkdir(dirname(filePath), { recursive: true });
}

async function* walk(dir: string): AsyncGenerator<string> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) yield* walk(full);
		else if (e.isFile()) yield full;
	}
}

function toPosixRelative(root: string, absPath: string): string {
	const rel = absPath.slice(root.length + (root.endsWith('/') ? 0 : 1));
	return rel.split(/\\/g).join('/');
}

export class LocalFileStore implements FileStore {
	constructor(private rootDir: string) {}

	async read(path: string): Promise<string | undefined> {
		const p = join(this.rootDir, path);
		try {
			return await fs.readFile(p, 'utf8');
		} catch (e: unknown) {
			if ((e as { code?: string })?.code === 'ENOENT') return undefined;
			throw e;
		}
	}

	async write(path: string, contents: string): Promise<void> {
		const p = join(this.rootDir, path);
		await ensureDir(p);
		// Normalize to LF and ensure trailing newline for stability
		const normalized = contents.replace(/\r\n/g, '\n');
		const finalText = normalized.endsWith('\n')
			? normalized
			: `${normalized}\n`;
		await fs.writeFile(p, finalText, 'utf8');
	}

	async remove(path: string): Promise<void> {
		const p = join(this.rootDir, path);
		try {
			await fs.unlink(p);
		} catch (e: unknown) {
			if ((e as { code?: string })?.code === 'ENOENT') return;
			throw e;
		}
	}

	async list(prefix?: string): Promise<string[]> {
		const out: string[] = [];
		const root = this.rootDir;
		try {
			for await (const abs of walk(root)) {
				const rel = toPosixRelative(root, abs);
				if (!prefix || rel.startsWith(prefix)) out.push(rel);
			}
		} catch (e: unknown) {
			if ((e as { code?: string })?.code === 'ENOENT') return [];
			throw e;
		}
		return out;
	}
}

export async function snapshotLocal(
	rootDir: string,
	prefix = 'vault/',
): Promise<FsSnapshot> {
	const files: Record<string, string> = {};
	try {
		for await (const abs of walk(rootDir)) {
			const rel = toPosixRelative(rootDir, abs);
			if (!rel.startsWith(prefix)) continue;
			const data = await fs.readFile(abs);
			const hash = createHash('sha256').update(data).digest('hex');
			files[rel] = hash;
		}
	} catch {
		// ignore
	}
	return { files, createdAt: new Date().toISOString() };
}
