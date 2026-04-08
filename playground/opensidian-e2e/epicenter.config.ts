/**
 * Opensidian workspace config — one-way materialization to markdown files.
 *
 * Syncs the Opensidian workspace from the Epicenter API, persists the files
 * table to SQLite, and materializes each file as a `.md` on disk with YAML
 * frontmatter (metadata) and markdown body (document content).
 *
 * Reads auth credentials from the CLI session store at
 * `~/.epicenter/auth/sessions.json` — run `epicenter auth login` first.
 *
 * Usage:
 *   epicenter start playground/opensidian-e2e --verbose
 *   epicenter list files -C playground/opensidian-e2e
 */

import { join } from 'node:path';
import {
	createCliUnlock,
	createSessionStore,
	resolveEpicenterHome,
} from '@epicenter/cli';
import { createWorkspace, defineMutation } from '@epicenter/workspace';
import { prepareMarkdownFiles } from '@epicenter/workspace/extensions/materializer/markdown';
import { filesystemPersistence } from '@epicenter/workspace/extensions/persistence/sqlite';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync/websocket';
import { opensidianDefinition } from 'opensidian/workspace';
import Type from 'typebox';
import { createOpensidianMaterializer } from './materializer';

const SERVER_URL = process.env.EPICENTER_SERVER ?? 'https://api.epicenter.so';
const PERSISTENCE_DIR = join(import.meta.dir, '.epicenter', 'persistence');
const MARKDOWN_DIR = join(import.meta.dir, 'data');

const sessions = createSessionStore(resolveEpicenterHome());

export const opensidian = createWorkspace(opensidianDefinition)
	.withExtension(
		'persistence',
		filesystemPersistence({
			filePath: join(PERSISTENCE_DIR, 'opensidian.db'),
		}),
	)
	.withWorkspaceExtension(
		'markdown',
		createOpensidianMaterializer({ directory: MARKDOWN_DIR }),
	)
	.withWorkspaceExtension('unlock', createCliUnlock(sessions, SERVER_URL))
	.withExtension(
		'sync',
		createSyncExtension({
			url: (docId) => `${SERVER_URL}/workspaces/${docId}`,
			getToken: async () => {
				const session = await sessions.load(SERVER_URL);
				return session?.accessToken ?? null;
			},
		}),
	)
	.withActions(() => ({
		/**
		 * Scan a directory for `.md` files and inject a unique `id` into the YAML
		 * frontmatter of any file that doesn't already have one. Errors if duplicate
		 * IDs are detected across files.
		 */
		markdown: {
			prepare: defineMutation({
				title: 'Prepare Markdown Files',
				description:
					'Add unique IDs to markdown files missing them in YAML frontmatter',
				input: Type.Object({ directory: Type.String() }),
				handler: async ({ directory }) => prepareMarkdownFiles(directory),
			}),
		},
	}));
