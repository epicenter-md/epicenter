import type { RuntimeOwner } from './types';

/** Browser renders the recording pill in-page, so it owns no overlay runtime. */
export const recordingOverlayRuntimeOwner: RuntimeOwner | null = null;
