import { exec as _exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { FileStore, FsSnapshot } from '../core/fs';
import type { SyncEngine } from '../core/sync';
import { LocalFileStore, snapshotLocal } from '../fs/local-file-store';

const exec = promisify(_exec);

export class GitSyncEngine implements SyncEngine {
	private store: LocalFileStore;
	constructor(
		private repoDir: string,
		private vaultRoot = 'vault/',
	) {
		this.store = new LocalFileStore(repoDir);
	}

	async getStore(): Promise<FileStore> {
		return this.store;
	}

	async pull(): Promise<FsSnapshot> {
		await exec('git fetch --all --prune', { cwd: this.repoDir });
		await exec('git pull --ff-only', { cwd: this.repoDir });
		return snapshotLocal(this.repoDir, this.vaultRoot);
	}

	async commit(message: string): Promise<void> {
		await exec(`git add ${this.vaultRoot}`, { cwd: this.repoDir });
		// Allow empty commit to record a sync event when nothing changed
		await exec(`git commit --allow-empty -m ${JSON.stringify(message)}`, {
			cwd: this.repoDir,
		});
	}

	async push(): Promise<void> {
		await exec('git push', { cwd: this.repoDir });
	}
}
