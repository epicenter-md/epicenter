import { createCommandServiceDesktop } from './desktop';
import { createCommandServiceWeb } from './web';

export type {
	CommandService,
	CommandServiceError,
	ShellCommand,
} from './types';
export { asShellCommand } from './types';

export const CommandServiceLive = window.__TAURI_INTERNALS__
	? createCommandServiceDesktop()
	: createCommandServiceWeb();
