import { DownloadServiceLive } from '../download';
import { createDbServiceDexie } from './dexie';

export type { DbService, DbServiceError } from './dexie';
export { createDbServiceDexie, DbServiceErr } from './dexie';
export type {
	InsertTransformationStep,
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
	TRANSFORMATION_STEP_TYPES,
	TRANSFORMATION_STEP_TYPES_TO_LABELS,
} from './models';

export const DbServiceLive = createDbServiceDexie({
	DownloadService: DownloadServiceLive,
});
