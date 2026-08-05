/**
 * The folder's two verbs, at the host's tool boundary.
 *
 * ADR-0207 says `status` and `push` are scans you run when you type them, and
 * this is where typing them happens: the host's one action surface (ADR-0021),
 * shared by the chat loop and by a direct invocation. Without it the folder
 * renders and stays current and nothing ever sends an edit back, which is a
 * read-only tree, and ADR-0207 rejected one of those by name.
 *
 * `push` is a `mutation`, so it raises the session's approval prompt before it
 * runs. That is the review step the design asks for, and it is why `status`
 * exists as a separate `query`: look first, then answer the prompt.
 *
 * Neither verb takes an argument. A path or table filter is the obvious thing to
 * add and is exactly what ADR-0207 forbids, because "no flag may skip the
 * deletion section of a push" and any narrowing flag is that flag.
 */

import type {
	AgentToolCall,
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from '@epicenter/agent';

import {
	type FolderWriter,
	formatPushReport,
	pushFolder,
} from './folder/push.ts';
import type { ReceiptStore } from './folder/receipts.ts';
import { scanFolder, type TableLookup } from './folder/scan.ts';
import { formatStatus, statusOf } from './folder/status.ts';

const STATUS_TOOL: AgentToolDefinition = {
	name: 'status',
	kind: 'query',
	title: 'Folder status',
	description:
		'List what the Epicenter folder is asking for: which files were edited and which fields would be sent, which files would create rows, and which rows are queued for deletion because no file claims them any more. Reads the folder and writes nothing.',
	inputSchema: {
		type: 'object',
		properties: {},
		additionalProperties: false,
	},
};

const PUSH_TOOL: AgentToolDefinition = {
	name: 'push',
	kind: 'mutation',
	title: 'Push the folder',
	description:
		'Send every field edited in the Epicenter folder back to the replica, mint rows for files with no id, and delete rows no file claims any more. Only fields that differ from what was last rendered are sent, so an untouched field can never overwrite another device. Run status first to see what this would do.',
	inputSchema: {
		type: 'object',
		properties: {},
		additionalProperties: false,
	},
};

export type FolderCatalogOptions = {
	/** The folder a person and an agent read (`~/Epicenter` by default). */
	root: string;
	receipts: ReceiptStore;
	lookup: TableLookup;
	writer: FolderWriter;
};

export function createFolderCatalog({
	root,
	receipts,
	lookup,
	writer,
}: FolderCatalogOptions): ToolCatalog {
	async function resolve(call: AgentToolCall): Promise<AgentToolOutcome> {
		if (call.toolName === STATUS_TOOL.name) {
			const status = statusOf(scanFolder({ root, receipts, lookup }));
			return {
				content: formatStatus(status),
				details: status,
				isError: false,
			};
		}
		if (call.toolName !== PUSH_TOOL.name) {
			return {
				content: `No folder tool named "${call.toolName}".`,
				isError: true,
			};
		}

		// Scanned once and handed to `pushFolder`, so what the report describes is
		// what was read, not a second read that could have moved underneath it.
		const entries = scanFolder({ root, receipts, lookup });
		const report = await pushFolder({
			root,
			receipts,
			lookup,
			writer,
			entries,
		});
		return {
			content: formatPushReport(report),
			details: report,
			isError: false,
		};
	}

	return {
		definitions: () => [STATUS_TOOL, PUSH_TOOL],
		resolve,
	};
}
