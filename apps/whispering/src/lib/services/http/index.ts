import { createHttpServiceDesktop } from './desktop';
import { createHttpServiceWeb } from './web';

// Re-export both types and factory functions
export type {
	ConnectionError,
	HttpService,
	HttpServiceError,
	ParseError,
	ResponseError,
} from './types';
export {
	ConnectionErr,
	ConnectionError,
	ParseErr,
	ParseError,
	ResponseErr,
	ResponseError,
} from './types';

export const HttpServiceLive = window.__TAURI_INTERNALS__
	? createHttpServiceDesktop()
	: createHttpServiceWeb();
