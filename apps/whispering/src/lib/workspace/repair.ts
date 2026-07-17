import type { OpenedWorkspace } from '@epicenter/workspace/sqlite';
import type { whisperingWorkspace } from './definition';

export type WhisperingWorkspace = OpenedWorkspace<typeof whisperingWorkspace>;

/**
 * One explicit application-owned repair for the pre-sourceId recording shape.
 * The runtime never runs this during reads and never guesses the replacement.
 */
export function repairRecordingSourceId({
	workspace,
	canonicalId,
	sourceId,
}: {
	workspace: WhisperingWorkspace;
	canonicalId: string;
	sourceId: string;
}) {
	return workspace.tables.recordings.update(canonicalId, { sourceId });
}
