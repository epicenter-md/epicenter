/** `@epicenter/agent`: a UI-free agent loop over explicit host capabilities. */

export { composeToolCatalogs } from './compose-tool-catalogs.js';
export type {
	AgentEngine,
	AgentEngineRequest,
	EngineChunk,
} from './engine.js';
export {
	createLocalToolCatalog,
	type LocalAction,
	type LocalActionRegistry,
} from './local-tool-catalog.js';
export {
	type AgentMessageStore,
	type ConversationError,
	type ConversationHandle,
	type ConversationOptions,
	type ConversationSnapshot,
	createConversation,
} from './loop.js';
export {
	type AgentMessage,
	type AgentMessagePart,
	type AgentMessageRole,
	type AgentTextPart,
	type AgentToolCallPart,
	type AgentToolResultPart,
	agentMessageText,
	isPersistableMessage,
	type ModelMessage,
	type ModelToolCall,
	toModelMessages,
} from './message.js';
export { namespaceToolCatalog } from './namespace-tool-catalog.js';
export {
	type AgentToolCall,
	type AgentToolDefinition,
	type AgentToolOutcome,
	type Approval,
	type ApprovalDecision,
	defaultApprovalDecision,
	NO_TOOLS,
	resolveApprovedToolCall,
	type ToolCatalog,
} from './tools.js';
