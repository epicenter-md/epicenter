import {
	deleteHoneycrispFolder,
	type HoneycrispWorkspace,
} from '@epicenter/honeycrisp';
import type {
	AgentToolCall,
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from '@epicenter/workspace/agent';

const DELETE_FOLDER_TOOL: AgentToolDefinition = {
	name: 'folders_delete',
	kind: 'mutation',
	description: 'Delete a folder and re-parent its notes to unfiled',
	inputSchema: {
		type: 'object',
		properties: { folderId: { type: 'string' } },
		required: ['folderId'],
		additionalProperties: false,
	},
};

/** Adapt Honeycrisp's async row operation to the Query host's tool boundary. */
export function createHoneycrispCatalog(
	workspace: HoneycrispWorkspace,
): ToolCatalog {
	async function resolve(call: AgentToolCall): Promise<AgentToolOutcome> {
		if (call.toolName !== DELETE_FOLDER_TOOL.name) {
			return {
				content: `No Honeycrisp tool named "${call.toolName}".`,
				isError: true,
			};
		}
		const folderId = readFolderId(call.input);
		if (folderId === undefined) {
			return { content: 'A "folderId" string is required.', isError: true };
		}
		try {
			await deleteHoneycrispFolder(workspace, folderId);
			return { content: 'null', details: null, isError: false };
		} catch (cause) {
			return {
				content: cause instanceof Error ? cause.message : String(cause),
				isError: true,
			};
		}
	}

	return { definitions: () => [DELETE_FOLDER_TOOL], resolve };
}

function readFolderId(input: AgentToolCall['input']): string | undefined {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		return undefined;
	}
	const folderId = (input as Record<string, unknown>).folderId;
	return typeof folderId === 'string' ? folderId : undefined;
}
