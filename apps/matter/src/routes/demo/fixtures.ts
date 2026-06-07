/**
 * Inlined fixtures for the `/demo` route: a realistic content-pipeline vault that
 * exercises every field kind AND every cell state, so the grid can be eyeballed in a
 * browser without a real folder.
 *
 * The model covers all nine palette kinds (string, select, multiSelect, tags,
 * datetime, integer, number, boolean, url), and the rows deliberately spread across
 * OK / NEEDS_VALUE / INVALID, plus unmodeled extras, a nested object, and two
 * unparseable files (malformed YAML, git conflict markers) so the "Can't read"
 * bucket renders too.
 *
 * Mirrors `examples/matter/sample-vault/drafts`, extended so a single screen shows
 * the full surface.
 */

/** The folder's `matter.json`, as raw text (parsed by `loadModel`, same as on disk). */
export const DEMO_MODEL_TEXT = JSON.stringify(
	{
		fields: {
			title: { type: 'string', minLength: 1 },
			status: {
				type: 'string',
				enum: ['draft', 'ready', 'published', 'archived'],
			},
			format: { type: 'string', enum: ['article', 'carousel', 'video'] },
			destinations: {
				type: 'array',
				items: {
					type: 'string',
					enum: ['blog', 'x', 'linkedin', 'instagram', 'youtube', 'reddit'],
				},
			},
			tags: { type: 'array', items: { type: 'string' } },
			publishDate: { type: 'string', format: 'date-time' },
			duration: { type: 'integer', minimum: 0 },
			readMinutes: { type: 'number' },
			featured: { type: 'boolean' },
			url: { type: 'string', format: 'uri' },
		},
	},
	null,
	'\t',
);

/** One demo file: its basename (row id) and raw markdown text (frontmatter + body). */
type DemoRow = { fileName: string; content: string };

export const DEMO_ROWS: DemoRow[] = [
	{
		fileName: 'best-mic-setup.md',
		content: `---
title: My Best Mic Setup
status: published
format: article
destinations:
  - blog
  - linkedin
tags:
  - audio
  - gear
publishDate: 2026-05-30T14:00:00Z
duration: 8
readMinutes: 6.5
featured: true
url: https://example.com/mic
---
Everything about the mic, written out at length so the body field has real prose
to show in the row detail panel when you expand it.
`,
	},
	{
		fileName: 'carousel-2026-trends.md',
		content: `---
title: 2026 Content Trends
status: ready
format: carousel
destinations:
  - instagram
  - linkedin
tags:
  - trends
publishDate: 2026-06-12T09:00:00Z
duration: 3
readMinutes: 2
featured: false
url: https://example.com/trends
---
Carousel outline.
`,
	},
	{
		fileName: 'how-i-edit-videos.md',
		content: `---
title: How I Edit My Videos Fast Without Losing the Plot or My Mind
status: ready
format: video
destinations:
  - youtube
  - x
tags:
  - editing
  - workflow
publishDate: 2026-06-10T17:30:00Z
duration: 12
readMinutes: 9.5
featured: true
url: https://example.com/source-clip
---
# How I Edit Videos Fast

The body is loose prose. It is never parsed for structure.
`,
	},
	{
		fileName: 'quick-thought.md',
		content: `---
title: A Quick Thought
status: draft
---
A stub with sparse frontmatter, so most fields still need a value.
`,
	},
	{
		fileName: 'norway-trip.md',
		content: `---
title: Trip to Norway
status: draft
format: article
destinations:
  - blog
publishDate: 2026-06-01
duration: soon
featured: true
country: NO
---
The country code NO stays the string "NO" (YAML 1.2). publishDate (date only, not
RFC 3339) and duration ("soon") are INVALID against the model and route to repair.
`,
	},
	{
		fileName: 'legacy-import.md',
		content: `---
title: Imported Note
status: draft
format: article
legacyId: ABC-123
mood: optimistic
metadata:
  importedFrom: oldcms
  version: 2
---
Has overflow keys (legacyId, mood) and a nested object (metadata) shown in the row detail.
`,
	},
	{
		fileName: 'broken.md',
		content: `---
title: Broken Frontmatter
status: [unclosed
  badly: indented
---
Unparseable: malformed YAML.
`,
	},
	{
		fileName: 'half-merged.md',
		content: `---
title: Half Merged Draft
<<<<<<< HEAD
status: draft
=======
status: ready
>>>>>>> feature
---
Unparseable: git conflict markers. The grid must never write this.
`,
	},
	{
		fileName: 'raw-note.md',
		content: `# Raw Note

No frontmatter at all, just markdown. Every modeled field needs a value.
`,
	},
];
