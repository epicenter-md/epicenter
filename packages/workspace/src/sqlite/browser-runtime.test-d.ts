/**
 * Browser runtime public capability type tests.
 *
 * The Browser binding exposes the same workspace handle as other runtimes,
 * while synchronization, room identity, Worker ownership, and OPFS paths stay
 * private runtime concerns.
 */
import { field } from '@epicenter/field';
import {
	type BrowserWorkspaceRuntime,
	createBrowserWorkspaceRuntime,
} from './browser-runtime.js';
import { document } from './document-definition.js';
import { defineTable } from './lens-definition.js';
import { defineWorkspace } from './runtime-definition.js';

const definition = defineWorkspace({
	id: 'browser-types',
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
	documents: {
		draft: document.text({ params: { noteId: field.string() } }),
	},
});

async function assertBrowserRuntimeCapabilities(
	runtime: BrowserWorkspaceRuntime,
): Promise<void> {
	const workspace = await runtime.open(definition);
	const note = await workspace.tables.notes.create({ title: 'Typed' });
	const title: string = note.title;
	void title;

	using draft = await workspace.documents.draft.open({ noteId: note.id });
	draft.content.write('typed document');

	// @ts-expect-error Synchronization is automatic and runtime-private.
	void runtime.synchronize;
	// @ts-expect-error Synchronization status is not a workspace capability.
	void workspace.sync;
	// @ts-expect-error Private room identifiers never enter document handles.
	void draft.storageRef;
	// @ts-expect-error Domain calls accept declared params, not runtime guids.
	void workspace.documents.draft.open({ guid: 'private' });
	// @ts-expect-error Live OPFS paths are not public capabilities.
	void workspace.path;
}

void assertBrowserRuntimeCapabilities;
void createBrowserWorkspaceRuntime;
