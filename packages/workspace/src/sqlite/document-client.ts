import type * as Y from 'yjs';
import type { Guid } from '../shared/id.js';
import {
	type DocumentFormat,
	type DocumentHandle,
	inspectDocumentFormat,
} from './document-format.js';
import {
	type DocumentReference,
	inspectDocumentReference,
} from './document-reference.js';

/** One caller-owned persistence and synchronization session for a Yjs room. */
export type WorkspaceDocumentSession = {
	doc: Y.Doc;
	/** Hydration and initial synchronization required before the first read. */
	whenReady?: Promise<unknown>;
	[Symbol.dispose](): void;
};

/** Runtime composition seam that opens one exact Yjs room by guid. */
export type WorkspaceDocumentRuntime = {
	open(guid: Guid): WorkspaceDocumentSession;
};

/** Typed document surface contributed when a child-document runtime is present. */
export type WorkspaceDocumentsFor<
	TRuntime extends WorkspaceDocumentRuntime | undefined,
> = [TRuntime] extends [undefined]
	? undefined
	: undefined extends TRuntime
		? WorkspaceDocuments | undefined
		: WorkspaceDocuments;

/** @internal Require the runtime exactly when the generic says it is present. */
export type WorkspaceDocumentRuntimeOption<
	TRuntime extends WorkspaceDocumentRuntime | undefined,
> = TRuntime extends WorkspaceDocumentRuntime
	? {
			/** Child-document persistence and synchronization runtime. */
			documents: TRuntime;
		}
	: {
			/** Omit for guid-only document handles. */
			documents?: undefined;
		};

/** One typed child document whose runtime session has been mounted. */
export type OpenedDocument<TFormat extends DocumentFormat> = {
	guid: Guid;
	content: DocumentHandle<TFormat>;
	whenReady: Promise<void>;
	[Symbol.dispose](): void;
};

/** Explicit opener for retained historical document references. */
export type WorkspaceDocuments = {
	open<TFormat extends DocumentFormat>(
		reference: DocumentReference<TFormat>,
		rowId: string,
	): OpenedDocument<TFormat>;
};

/** @internal Bind nominal references to one workspace family's runtime. */
export function createWorkspaceDocuments(
	workspaceId: string,
	runtime: WorkspaceDocumentRuntime,
	assertOpen: () => void = () => undefined,
): WorkspaceDocuments {
	return {
		open(reference, rowId) {
			assertOpen();
			const referenceDefinition = inspectDocumentReference(reference);
			if (referenceDefinition.workspaceId !== workspaceId) {
				throw new Error(
					`Document reference belongs to workspace '${referenceDefinition.workspaceId}', not '${workspaceId}'`,
				);
			}
			const guid = reference.guid(rowId);
			const session = runtime.open(guid);
			let disposed = false;
			function dispose(): void {
				if (disposed) return;
				disposed = true;
				session[Symbol.dispose]();
			}
			function failAfterDispose(cause: unknown): never {
				try {
					dispose();
				} catch (cleanupCause) {
					throw new AggregateError(
						[cause, cleanupCause],
						'Document open failed and session cleanup also failed',
						{ cause },
					);
				}
				throw cause;
			}

			try {
				if (session.doc.guid !== guid) {
					throw new Error(
						`Document runtime opened '${session.doc.guid}' for requested room '${guid}'`,
					);
				}
				const content = inspectDocumentFormat(
					referenceDefinition.format,
				).attach(session.doc) as DocumentHandle<
					typeof referenceDefinition.format
				>;
				const whenReady = Promise.resolve(session.whenReady).then(
					() => undefined,
					failAfterDispose,
				);
				return {
					guid,
					content,
					whenReady,
					[Symbol.dispose]: dispose,
				};
			} catch (cause) {
				failAfterDispose(cause);
			}
		},
	};
}
