/**
 * Whispering workspace client — single Y.Doc with IndexedDB persistence.
 *
 * Future sync extensions will add remote replication.
 */

import { createWorkspace } from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import { whisperingDefinition } from './workspace/definition';

export const workspace = createWorkspace(whisperingDefinition).withExtension(
	'persistence',
	indexeddbPersistence,
);
