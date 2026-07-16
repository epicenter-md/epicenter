import { field } from '@epicenter/field';
import type { Brand } from 'wellcrafted/brand';
import { document } from './document-definition.js';
import type { DocumentNamespace } from './document-runtime.js';

type SkillId = string & Brand<'SkillId'>;

const definitions = {
	instructions: document.text({ params: { skillId: field.string<SkillId>() } }),
	preferences: document.keyValue({
		entries: { theme: field.select(['light', 'dark']) },
	}),
};

declare const documents: DocumentNamespace<typeof definitions>;

void documents.instructions.open({ skillId: 'skill-a' as SkillId });
void documents.preferences.open();

// @ts-expect-error Domain parameters are required for parameterized documents.
void documents.instructions.open();
void documents.instructions.open({
	skillId: 'skill-a' as SkillId,
	// @ts-expect-error Public document calls never accept a room guid.
	guid: 'private-room',
});
void documents.instructions.open({
	skillId: 'skill-a' as SkillId,
	// @ts-expect-error Public document calls never accept authority identity.
	authorityKey: 'principal-alice',
});
// @ts-expect-error Parameterless documents reject domain parameters.
void documents.preferences.open({ skillId: 'skill-a' as SkillId });
// @ts-expect-error The public namespace exposes no local eviction control.
void documents.instructions.evictLocal;
// @ts-expect-error The public namespace exposes no hard-delete control.
void documents.instructions.delete;
// @ts-expect-error The public namespace exposes no manual synchronization control.
void documents.instructions.sync;

const opened = await documents.instructions.open({
	skillId: 'skill-a' as SkillId,
});
// @ts-expect-error A lease does not expose its private room identifier.
void opened.guid;
// @ts-expect-error A lease does not expose its Y.Doc.
void opened.ydoc;
