import { toast } from '@epicenter/ui/sonner';
import { fs } from '$lib/client';

function createSampleDataLoader() {
	let seeding = $state(false);

	return {
		get seeding() {
			return seeding;
		},
		async load() {
			seeding = true;
			try {
				await fs.mkdir('/docs');
				await fs.mkdir('/src');
				await fs.mkdir('/src/utils');
				await fs.writeFile(
					'/README.md',
					'# FS Explorer\n\nA demo app for the Epicenter filesystem package.\n',
				);
				await fs.writeFile(
					'/docs/api.md',
					'# API Reference\n\n## YjsFileSystem\n\nThe main filesystem class.\n\n### Methods\n\n- `writeFile(path, content)` — Create or overwrite a file\n- `mkdir(path)` — Create a directory\n- `rm(path, opts)` — Remove a file or directory\n- `mv(from, to)` — Move or rename\n',
				);
				await fs.writeFile(
					'/docs/guide.md',
					'# Getting Started\n\n## Installation\n\n```bash\nbun add @epicenter/filesystem\n```\n\n## Quick Start\n\nCreate a workspace and filesystem instance, then use familiar path-based APIs.\n',
				);
				await fs.writeFile(
					'/src/index.ts',
					'import { YjsFileSystem } from "@epicenter/filesystem";\n\nexport function createApp() {\n  console.log("FS Explorer initialized");\n}\n',
				);
				await fs.writeFile(
					'/src/utils/helpers.ts',
					'/** Format a file size in bytes to a human-readable string. */\nexport function formatBytes(bytes: number): string {\n  if (bytes === 0) return "0 B";\n  const k = 1024;\n  const sizes = ["B", "KB", "MB", "GB"];\n  const i = Math.floor(Math.log(bytes) / Math.log(k));\n  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;\n}\n',
				);
				toast.success('Loaded sample data');
			} catch (err) {
				toast.error(
					err instanceof Error ? err.message : 'Failed to load sample data',
				);
				console.error(err);
			} finally {
				seeding = false;
			}
		},
	};
}

export const sampleDataLoader = createSampleDataLoader();
