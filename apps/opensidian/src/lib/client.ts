import { APP_URLS } from '@epicenter/constants/vite';
import { createSqliteIndex, createYjsFileSystem } from '@epicenter/filesystem';
import { createSkillsWorkspace } from '@epicenter/skills';
import { createAuth } from '@epicenter/svelte/auth';
import {
	createWorkspace,
	defineMutation,
	defineQuery,
} from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import {
	createSyncExtension,
	toWsUrl,
} from '@epicenter/workspace/extensions/sync/websocket';
import { Bash } from 'just-bash';
import Type from 'typebox';
import { session } from '$lib/auth';
import { opensidianDefinition } from './workspace/definition';

/**
 * Opensidian workspace infrastructure.
 *
 * Creates the Yjs workspace, filesystem abstraction, and extensions.
 * Imported by both fs-state.svelte.ts (for reactive wrappers) and
 * components that need direct infra access (Toolbar, ContentEditor).
 */
export const workspace = buildWorkspaceClient();

function buildWorkspaceClient() {
	return createWorkspace(opensidianDefinition)
		.withExtension('persistence', indexeddbPersistence)
		.withExtension(
			'sync',
			createSyncExtension({
				url: (workspaceId) =>
					toWsUrl(`${APP_URLS.API}/workspaces/${workspaceId}`),
				getToken: async () => auth.token,
			}),
		)
		.withWorkspaceExtension('sqliteIndex', createSqliteIndex())
		.withActions((client) => ({
			files: {
				search: defineQuery({
					title: 'Search Notes',
					description:
						'Search notes by content using full-text search. Returns matching file paths and content snippets.',
					input: Type.Object({
						query: Type.String({ description: 'The search query string' }),
					}),
					handler: async ({ query }) => {
						const results = client.extensions.sqliteIndex.search(query);
						return results;
					},
				}),
				read: defineQuery({
					title: 'Read File',
					description:
						'Read the full content of a file by its absolute path (e.g. "/notes/meeting.md").',
					input: Type.Object({
						path: Type.String({
							description: 'Absolute file path starting with /',
						}),
					}),
					handler: async ({ path }) => {
						const content = await fs.readFile(path);
						const MAX_LENGTH = 50_000;

						if (content.length > MAX_LENGTH) {
							return {
								content: content.slice(0, MAX_LENGTH),
								truncated: true,
								totalLength: content.length,
								note: `Content truncated at ${MAX_LENGTH} chars. Use bash head/tail for specific sections.`,
							};
						}

						return { content, truncated: false };
					},
				}),
				list: defineQuery({
					title: 'List Directory',
					description:
						'List files and folders in a directory. Use "/" for the root.',
					input: Type.Object({
						path: Type.Optional(
							Type.String({ description: 'Directory path. Defaults to "/"' }),
						),
					}),
					handler: async ({ path }) => {
						const entries = await fs.readdir(path ?? '/');
						return { entries };
					},
				}),
				write: defineMutation({
					title: 'Write File',
					description:
						'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
					input: Type.Object({
						path: Type.String({ description: 'Absolute file path' }),
						content: Type.String({ description: 'The content to write' }),
					}),
					handler: async ({ path, content }) => {
						await fs.writeFile(path, content);
						return { success: true, path };
					},
				}),
				create: defineMutation({
					title: 'Create File',
					description: 'Create a new empty file at the given path.',
					input: Type.Object({
						path: Type.String({
							description: 'Absolute file path for the new file',
						}),
					}),
					handler: async ({ path }) => {
						await fs.writeFile(path, '');
						return { success: true, path };
					},
				}),
				delete: defineMutation({
					title: 'Delete File',
					description: 'Delete a file or directory at the given path.',
					input: Type.Object({
						path: Type.String({ description: 'Absolute path to delete' }),
					}),
					handler: async ({ path }) => {
						await fs.rm(path);
						return { success: true, path };
					},
				}),
				move: defineMutation({
					title: 'Move/Rename File',
					description: 'Move or rename a file from one path to another.',
					input: Type.Object({
						src: Type.String({ description: 'Current file path' }),
						dst: Type.String({ description: 'New file path' }),
					}),
					handler: async ({ src, dst }) => {
						await fs.mv(src, dst);
						return { success: true, from: src, to: dst };
					},
				}),
				mkdir: defineMutation({
					title: 'Create Directory',
					description: 'Create a new directory at the given path.',
					input: Type.Object({
						path: Type.String({ description: 'Absolute directory path' }),
					}),
					handler: async ({ path }) => {
						await fs.mkdir(path);
						return { success: true, path };
					},
				}),
			},
			bash: {
				exec: defineMutation({
					title: 'Execute Bash Command',
					description:
						'Execute a bash command against the virtual filesystem. Supports standard Unix commands (ls, cat, grep, echo, etc.).',
					input: Type.Object({
						command: Type.String({
							description: 'The bash command to execute',
						}),
					}),
					handler: async ({ command }) => {
						const result = await bash.exec(command);
						return {
							stdout: result.stdout,
							stderr: result.stderr,
							exitCode: result.exitCode,
						};
					},
				}),
			},
		}));
}

/**
 * Global skills workspace — ecosystem-wide skills shared across all Epicenter apps.
 *
 * This is a SEPARATE workspace from the main opensidian workspace. It uses its own
 * Yjs document (`epicenter.skills`) with its own IndexedDB persistence. Skills are
 * imported via the CLI (`epicenter skills import`) or the dedicated skills app, then
 * synced to all Epicenter apps via the skills workspace CRDT.
 *
 * The skills workspace provides read actions for progressive skill disclosure:
 * - `listSkills()` — catalog (id, name, description) — cheap, no docs opened
 * - `getSkill({ id })` — metadata + instructions — opens one Y.Doc
 * - `getSkillWithReferences({ id })` — full skill with all references
 *
 * These skills form Layer 2 of the system prompt (after the base prompt, before
 * vault skills). They define ecosystem-wide conventions like writing voice,
 * documentation patterns, and TypeScript style.
 *
 * @see {@link file://./state/skill-state.svelte.ts} for the two-layer skill loader
 */
export const skillsWorkspace = createSkillsWorkspace().withExtension(
	'persistence',
	indexeddbPersistence,
);

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
	onLogin(session) {
		workspace.applyEncryptionKeys(session.encryptionKeys);
		workspace.extensions.sync.reconnect();
	},
	onLogout() {
		workspace.clearLocalData();
		workspace.extensions.sync.reconnect();
	},
});

/** AI tool representations for the opensidian workspace. */
export const workspaceAiTools = actionsToAiTools(workspace.actions);

/** Tool array type for use in TanStack AI generics. */
export type WorkspaceTools = typeof workspaceAiTools.tools;

/** Yjs-backed virtual filesystem with path-based operations. */
export const fs = createYjsFileSystem(
	workspace.tables.files,
	workspace.documents.files.content,
);

/**
 * Shell emulator backed by the Yjs virtual filesystem.
 *
 * Executes `just-bash` commands against the same `fs` used by the UI,
 * so files created via `echo "x" > /foo.md` are immediately visible
 * in the file tree. Shell state (env, cwd) resets between `exec()` calls.
 *
 * @example
 * ```typescript
 * const result = await bash.exec('echo "hello" > /greeting.md');
 * const cat = await bash.exec('cat /greeting.md');
 * console.log(cat.stdout); // "hello\n"
 * ```
 */
export const bash = new Bash({ fs, cwd: '/' });
