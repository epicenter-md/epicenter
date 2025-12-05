import { DownloadServiceLive } from '../download';
import { createDbServiceDesktop } from './desktop';
import { createDbServiceWeb } from './web';

export type {
	Recording,
	Transformation,
	TransformationRun,
	TransformationRunCompleted,
	TransformationRunFailed,
	TransformationStep,
	TransformationStepRun,
} from './models';
export {
	generateDefaultTransformation,
	generateDefaultTransformationStep,
} from './models';
export type { DbService, DbServiceError } from './types';
export { DbServiceErr } from './types';

export const DbServiceLive = window.__TAURI_INTERNALS__
	? createDbServiceDesktop({ DownloadService: DownloadServiceLive })
	: createDbServiceWeb({ DownloadService: DownloadServiceLive });
