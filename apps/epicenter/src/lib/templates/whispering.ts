/**
 * Whispering workspace template.
 *
 * Mirrors the core recording schema used by Epicenter Whispering so that
 * recordings and transcriptions can be shared across apps via a unified
 * Epicenter workspace.
 */

import {
	id,
	select,
	table,
	text,
	type WorkspaceDefinition,
} from '@epicenter/hq/dynamic';

export const WHISPERING_TEMPLATE = {
	id: 'epicenter.whispering',
	name: 'Whispering',
	description: '',
	icon: null,
	tables: [
		table({
			id: 'recordings',
			name: 'Recordings',
			icon: '🎙️',
			description: 'Voice recordings and transcriptions',
			fields: [
				id(),
				text({ id: 'title', name: 'Title' }),
				text({ id: 'subtitle', name: 'Subtitle' }),
				text({ id: 'timestamp', name: 'Timestamp' }),
				text({ id: 'createdAt', name: 'Created At' }),
				text({ id: 'updatedAt', name: 'Updated At' }),
				text({ id: 'transcribedText', name: 'Transcribed Text' }),
				select({
					id: 'transcriptionStatus',
					name: 'Status',
					options: ['UNPROCESSED', 'TRANSCRIBING', 'DONE', 'FAILED'],
				}),
			],
		}),
	],
	kv: [],
} as const satisfies WorkspaceDefinition;
