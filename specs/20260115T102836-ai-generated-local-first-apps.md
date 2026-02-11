# AI-Generated Local-First Applications

**Status**: Vision / Early Exploration  
**Date**: 2026-01-15  
**Author**: Braden Wong + Claude

---

## Executive Summary

This specification outlines a system where AI generates **complete local-first applications** from natural language, including both the data schema and user interface. Everything persists as JSON files the user owns.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   User: "Create a habit tracker for my morning routine"                     │
│                                                                             │
│                                    │                                        │
│                                    ▼                                        │
│                                                                             │
│                         ┌─────────────────┐                                 │
│                         │   AI Generator  │                                 │
│                         │  (Guardrailed)  │                                 │
│                         └────────┬────────┘                                 │
│                                  │                                          │
│                    ┌─────────────┴─────────────┐                            │
│                    │                           │                            │
│                    ▼                           ▼                            │
│           ┌───────────────┐           ┌───────────────┐                     │
│           │  schema.json  │           │    ui.json    │                     │
│           │  (structure)  │           │  (interface)  │                     │
│           └───────────────┘           └───────────────┘                     │
│                    │                           │                            │
│                    └─────────────┬─────────────┘                            │
│                                  │                                          │
│                                  ▼                                          │
│                         ┌───────────────┐                                   │
│                         │   data.yjs    │                                   │
│                         │ (user's data) │                                   │
│                         └───────────────┘                                   │
│                                                                             │
│   Result: User owns schema, interface, AND data as local files              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## The Problem

Current approaches force trade-offs:

| Tool             | Schema Flexibility  | Data Ownership | AI Generation |
| ---------------- | ------------------- | -------------- | ------------- |
| Notion           | High                | No (cloud)     | Partial       |
| Airtable         | High                | No (cloud)     | No            |
| Obsidian         | None (unstructured) | Yes            | No            |
| json-render      | None (fixed)        | N/A            | UI only       |
| Traditional Apps | None (hardcoded)    | Varies         | No            |

**No existing solution lets AI generate both schema AND interface while keeping everything locally owned.**

---

## The Vision

### Core Principle

> **If both schema AND interface are JSON, AI can generate complete applications that users fully own.**

### What This Enables

1. **Natural language to application**: "Track my reading habits" → complete app
2. **User-owned everything**: Schema, UI, and data are local files
3. **Portable**: Move your workspace to any device, grep it, back it up
4. **Modifiable**: Edit schema.json in a text editor or UI
5. **Syncable**: Yjs handles cross-device sync automatically

---

## Architecture

### File Structure

```
~/.epicenter/
├── workspaces/
│   │
│   ├── habit-tracker/                    ← AI-generated workspace
│   │   ├── schema.json                   ← Data structure (AI-generated)
│   │   ├── ui.json                       ← Interface layout (AI-generated)
│   │   ├── data.yjs                      ← Yjs CRDT document (user's data)
│   │   └── data.db                       ← SQLite materialization (queries)
│   │
│   ├── recipe-book/                      ← Another AI-generated workspace
│   │   ├── schema.json
│   │   ├── ui.json
│   │   ├── data.yjs
│   │   └── data.db
│   │
│   └── reading-log/
│       └── ...
│
├── components/                           ← Shared UI component catalog
│   └── catalog.json
│
└── config.json                           ← Global settings
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INPUT                                     │
│                                                                             │
│   "I want to track books I'm reading with notes and ratings"                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AI GENERATION LAYER                               │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Constraints (Guardrails):                                           │   │
│   │ • Schema: Only allowed column types (id, text, int, date, ref, etc.)│   │
│   │ • UI: Only components in catalog.json (Card, Table, Form, Chart)    │   │
│   │ • Limits: Max 20 tables, max 50 fields per table                    │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
┌───────────────────────────────────┐ ┌───────────────────────────────────────┐
│         schema.json               │ │              ui.json                  │
│                                   │ │                                       │
│ {                                 │ │ {                                     │
│   "id": "reading-log",            │ │   "root": {                           │
│   "tables": {                     │ │     "type": "Dashboard",              │
│     "books": {                    │ │     "props": { "title": "My Books" }, │
│       "id": { "type": "id" },     │ │     "children": [                     │
│       "title": { "type": "text" },│ │       {                               │
│       "author": { "type": "text" }│ │         "type": "DataTable",          │
│       "rating": {                 │ │         "props": {                    │
│         "type": "integer",        │ │           "source": "/books",         │
│         "min": 1, "max": 5        │ │           "columns": ["title",        │
│       },                          │ │             "author", "rating"]       │
│       "notes": {                  │ │         }                             │
│         "type": "text",           │ │       },                              │
│         "nullable": true          │ │       {                               │
│       }                           │ │         "type": "StatCard",           │
│     },                            │ │         "props": {                    │
│     "readingSessions": {          │ │           "label": "Books Read",      │
│       "bookId": {                 │ │           "value": { "count": "/books"}│
│         "type": "ref",            │ │         }                             │
│         "references": "books"     │ │       }                               │
│       },                          │ │     ]                                 │
│       "date": { "type": "date" }, │ │   }                                   │
│       "pagesRead": {              │ │ }                                     │
│         "type": "integer"         │ │                                       │
│       }                           │ │                                       │
│     }                             │ │                                       │
│   }                               │ │                                       │
│ }                                 │ │                                       │
│                                   │ │                                       │
└───────────────────────────────────┘ └───────────────────────────────────────┘
                    │                               │
                    └───────────────┬───────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          EPICENTER RUNTIME                                  │
│                                                                             │
│   1. Load schema.json → Create ArkType validators dynamically               │
│   2. Load ui.json → Render Svelte components from tree                      │
│   3. Initialize data.yjs → Empty Yjs doc matching schema structure          │
│   4. Connect providers → SQLite materialization, sync                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           USER INTERACTION                                  │
│                                                                             │
│   • Add books → Validated against schema → Stored in Yjs → Synced           │
│   • View dashboard → Rendered from ui.json → Data bound from Yjs            │
│   • Modify schema → AI regenerates or user edits JSON directly              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Schema Format Specification

### Column Types

```json
{
	"columnTypes": {
		"id": {
			"description": "Auto-generated unique identifier",
			"example": { "type": "id" }
		},
		"text": {
			"description": "String value",
			"options": ["maxLength", "minLength", "pattern"],
			"example": { "type": "text", "maxLength": 500 }
		},
		"integer": {
			"description": "Whole number",
			"options": ["min", "max", "default"],
			"example": { "type": "integer", "min": 1, "max": 5 }
		},
		"number": {
			"description": "Decimal number",
			"options": ["min", "max", "default"],
			"example": { "type": "number", "min": 0 }
		},
		"boolean": {
			"description": "True/false value",
			"options": ["default"],
			"example": { "type": "boolean", "default": false }
		},
		"date": {
			"description": "Calendar date (YYYY-MM-DD)",
			"example": { "type": "date" }
		},
		"datetime": {
			"description": "Date and time (ISO 8601)",
			"example": { "type": "datetime" }
		},
		"ref": {
			"description": "Reference to another table",
			"required": ["references"],
			"example": { "type": "ref", "references": "books" }
		},
		"enum": {
			"description": "One of predefined values",
			"required": ["values"],
			"example": { "type": "enum", "values": ["todo", "in-progress", "done"] }
		},
		"json": {
			"description": "Arbitrary JSON object",
			"example": { "type": "json" }
		}
	}
}
```

### Full Schema Example

```json
{
	"$schema": "https://epicenter.so/schemas/workspace-v1.json",
	"id": "habit-tracker",
	"name": "Morning Routine Tracker",
	"description": "Track daily habits and build streaks",
	"version": 1,
	"tables": {
		"habits": {
			"id": { "type": "id" },
			"name": { "type": "text", "maxLength": 100 },
			"description": { "type": "text", "nullable": true },
			"icon": { "type": "text", "default": "check" },
			"targetFrequency": {
				"type": "enum",
				"values": ["daily", "weekly", "custom"]
			},
			"createdAt": { "type": "datetime" }
		},
		"completions": {
			"id": { "type": "id" },
			"habitId": { "type": "ref", "references": "habits" },
			"completedAt": { "type": "datetime" },
			"notes": { "type": "text", "nullable": true }
		}
	},
	"computedFields": {
		"habits.currentStreak": {
			"type": "integer",
			"compute": "COUNT consecutive completions"
		}
	}
}
```

---

## UI Format Specification

### Component Catalog

AI can only use components defined in the catalog:

```json
{
	"$schema": "https://epicenter.so/schemas/ui-catalog-v1.json",
	"components": {
		"Dashboard": {
			"description": "Root container with title and grid layout",
			"props": {
				"title": { "type": "string", "required": true },
				"columns": { "type": "integer", "default": 2 }
			},
			"hasChildren": true
		},
		"DataTable": {
			"description": "Table displaying records from a data source",
			"props": {
				"source": { "type": "dataPath", "required": true },
				"columns": { "type": "array", "items": "string" },
				"sortable": { "type": "boolean", "default": true },
				"filterable": { "type": "boolean", "default": true }
			}
		},
		"StatCard": {
			"description": "Card showing a single metric",
			"props": {
				"label": { "type": "string", "required": true },
				"value": { "type": "dataBinding", "required": true },
				"format": {
					"type": "enum",
					"values": ["number", "currency", "percent"]
				}
			}
		},
		"Form": {
			"description": "Data entry form for a table",
			"props": {
				"target": { "type": "dataPath", "required": true },
				"fields": { "type": "array", "items": "string" },
				"submitLabel": { "type": "string", "default": "Save" }
			}
		},
		"Chart": {
			"description": "Data visualization",
			"props": {
				"type": { "type": "enum", "values": ["bar", "line", "pie", "area"] },
				"source": { "type": "dataPath", "required": true },
				"xAxis": { "type": "string" },
				"yAxis": { "type": "string" }
			}
		},
		"Calendar": {
			"description": "Calendar view of dated records",
			"props": {
				"source": { "type": "dataPath", "required": true },
				"dateField": { "type": "string", "required": true },
				"titleField": { "type": "string" }
			}
		},
		"KanbanBoard": {
			"description": "Kanban-style board with columns",
			"props": {
				"source": { "type": "dataPath", "required": true },
				"groupBy": { "type": "string", "required": true },
				"titleField": { "type": "string" }
			}
		}
	},
	"actions": {
		"create": {
			"description": "Create a new record",
			"params": { "target": "dataPath", "data": "object" }
		},
		"update": {
			"description": "Update an existing record",
			"params": { "target": "dataPath", "id": "string", "data": "object" }
		},
		"delete": {
			"description": "Delete a record",
			"params": { "target": "dataPath", "id": "string" }
		},
		"navigate": {
			"description": "Navigate to a view",
			"params": { "view": "string" }
		}
	}
}
```

### Full UI Example

```json
{
	"$schema": "https://epicenter.so/schemas/ui-v1.json",
	"workspaceId": "habit-tracker",
	"views": {
		"main": {
			"type": "Dashboard",
			"props": {
				"title": "Morning Routine",
				"columns": 2
			},
			"children": [
				{
					"key": "today-habits",
					"type": "Card",
					"props": { "title": "Today's Habits", "span": 2 },
					"children": [
						{
							"type": "HabitChecklist",
							"props": {
								"source": "/habits",
								"completionsSource": "/completions",
								"dateFilter": "today"
							}
						}
					]
				},
				{
					"key": "streak-card",
					"type": "StatCard",
					"props": {
						"label": "Current Streak",
						"value": { "max": "/habits/*/currentStreak" },
						"format": "number",
						"suffix": " days"
					}
				},
				{
					"key": "completion-rate",
					"type": "StatCard",
					"props": {
						"label": "This Week",
						"value": { "percent": "/completions?thisWeek / /habits?count * 7" },
						"format": "percent"
					}
				},
				{
					"key": "history-chart",
					"type": "Chart",
					"props": {
						"type": "area",
						"source": "/completions",
						"xAxis": "completedAt",
						"yAxis": { "count": "habitId" },
						"span": 2
					}
				}
			]
		},
		"habits": {
			"type": "Dashboard",
			"props": { "title": "Manage Habits" },
			"children": [
				{
					"type": "DataTable",
					"props": {
						"source": "/habits",
						"columns": ["name", "targetFrequency", "currentStreak"],
						"actions": ["edit", "delete"]
					}
				},
				{
					"type": "Form",
					"props": {
						"target": "/habits",
						"fields": ["name", "description", "icon", "targetFrequency"],
						"submitLabel": "Add Habit"
					}
				}
			]
		}
	},
	"navigation": [
		{ "label": "Today", "view": "main", "icon": "home" },
		{ "label": "Habits", "view": "habits", "icon": "list" }
	]
}
```

---

## Runtime Architecture

### Loading a Workspace

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   const workspace = await loadWorkspace('habit-tracker');                   │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Step 1: Load schema.json                                            │   │
│   │         → Parse JSON                                                │   │
│   │         → Create ArkType validators for each table                  │   │
│   │         → Build table helpers with CRUD operations                  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Step 2: Load ui.json                                                │   │
│   │         → Parse JSON                                                │   │
│   │         → Validate against component catalog                        │   │
│   │         → Build component tree                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Step 3: Initialize data layer                                       │   │
│   │         → Load or create data.yjs                                   │   │
│   │         → Connect SQLite provider (data.db)                         │   │
│   │         → Set up sync providers (if configured)                     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Step 4: Return workspace client                                     │   │
│   │                                                                     │   │
│   │   workspace.tables.habits.create({ name: 'Meditate' })              │   │
│   │   workspace.tables.habits.findMany({ where: { ... } })              │   │
│   │   workspace.ui.render(container)                                    │   │
│   │   workspace.ui.currentView                                          │   │
│   │                                                                     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Svelte Renderer

```svelte
<!-- WorkspaceRenderer.svelte -->
<script lang="ts">
	import type { UITree, ComponentRegistry } from '@epicenter/ui';
	import { getContext } from 'svelte';

	type Props = {
		tree: UITree;
	};

	let { tree }: Props = $props();

	const registry = getContext<ComponentRegistry>('components');
	const workspace = getContext<Workspace>('workspace');
</script>

{#each tree.children as node (node.key)}
	{@const Component = registry[node.type]}

	{#if Component}
		<Component
			{...node.props}
			data={workspace.bindData(node.props.source)}
			onAction={(action) => workspace.executeAction(action)}
		>
			{#if node.children}
				<svelte:self tree={{ children: node.children }} />
			{/if}
		</Component>
	{:else}
		<div class="error">Unknown component: {node.type}</div>
	{/if}
{/each}
```

---

## Schema Migrations

When schemas change, data must migrate:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SCHEMA MIGRATION                                   │
│                                                                             │
│   Before (v1):                      After (v2):                             │
│   {                                 {                                       │
│     "habits": {                       "habits": {                           │
│       "name": "text"                    "name": "text",                     │
│     }                     ────────▶     "category": "text",    ← NEW        │
│   }                                     "archived": "boolean"  ← NEW        │
│                                       }                                     │
│                                     }                                       │
│                                                                             │
│   Migration Strategy:                                                       │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ • ADDITIVE changes (new fields): Auto-apply, use defaults           │   │
│   │ • NULLABLE changes: Auto-apply, existing data becomes null          │   │
│   │ • TYPE changes: Require explicit migration function                 │   │
│   │ • DESTRUCTIVE changes (remove field): Warn user, keep in Yjs        │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   Yjs handles this gracefully:                                              │
│   • New fields: Just start writing them                                     │
│   • Removed fields: Data stays in doc, just not rendered                    │
│   • Type changes: Yjs stores raw values, validation at read time            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Security & Guardrails

### AI Generation Constraints

```json
{
	"guardrails": {
		"schema": {
			"maxTables": 20,
			"maxFieldsPerTable": 50,
			"maxSchemaSize": "100KB",
			"allowedTypes": [
				"id",
				"text",
				"integer",
				"number",
				"boolean",
				"date",
				"datetime",
				"ref",
				"enum",
				"json"
			],
			"forbiddenFieldNames": ["__proto__", "constructor", "prototype"]
		},
		"ui": {
			"maxComponents": 100,
			"maxNestingDepth": 10,
			"allowedComponents": ["from catalog.json only"],
			"noArbitraryCode": true,
			"noExternalUrls": true
		},
		"data": {
			"maxRecordsPerTable": 100000,
			"maxRecordSize": "1MB",
			"maxTotalSize": "1GB"
		}
	}
}
```

### Validation Pipeline

```
User Prompt
     │
     ▼
┌──────────────┐
│ AI generates │
│    JSON      │
└──────┬───────┘
       │
       ▼
┌──────────────┐     ┌──────────────┐
│   Schema     │────▶│   Reject +   │
│  Validation  │ NO  │   Feedback   │
└──────┬───────┘     └──────────────┘
       │ YES
       ▼
┌──────────────┐     ┌──────────────┐
│     UI       │────▶│   Reject +   │
│  Validation  │ NO  │   Feedback   │
└──────┬───────┘     └──────────────┘
       │ YES
       ▼
┌──────────────┐
│    Save &    │
│    Render    │
└──────────────┘
```

---

## Comparison with Existing Approaches

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                        FLEXIBILITY                                          │
│                            ▲                                                │
│                            │                                                │
│                            │         ┌─────────────────┐                    │
│                            │         │   EPICENTER +   │ ◀── The goal      │
│                            │         │  AI GENERATION  │                    │
│                            │         └─────────────────┘                    │
│           ┌────────────┐   │                                                │
│           │   Notion   │   │   ┌─────────────┐                              │
│           └────────────┘   │   │  Airtable   │                              │
│                            │   └─────────────┘                              │
│                            │                                                │
│   ┌────────────┐           │           ┌─────────────┐                      │
│   │  Obsidian  │           │           │ json-render │                      │
│   └────────────┘           │           └─────────────┘                      │
│                            │                                                │
│        ┌───────────────┐   │                                                │
│        │ Traditional   │   │                                                │
│        │    Apps       │   │                                                │
│        └───────────────┘   │                                                │
│                            │                                                │
│  ──────────────────────────┼──────────────────────────────▶ DATA OWNERSHIP  │
│        Cloud-locked        │           Local-first                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: JSON Schema Runtime

- [ ] Define schema.json format specification
- [ ] Build schema loader → ArkType validators
- [ ] Dynamic table helpers from JSON schemas
- [ ] Migration detection and handling

### Phase 2: UI Catalog & Renderer

- [ ] Define component catalog format
- [ ] Build Svelte dynamic renderer
- [ ] Data binding system (JSON Pointer paths)
- [ ] Action system (create, update, delete, navigate)

### Phase 3: AI Generation

- [ ] Schema generation prompt engineering
- [ ] UI generation prompt engineering
- [ ] Guardrail validation layer
- [ ] Iterative refinement ("Add a chart for...")

### Phase 4: Editor Experience

- [ ] Visual schema editor (drag-drop fields)
- [ ] Visual UI editor (drag-drop components)
- [ ] Live preview
- [ ] Version history

---

## Open Questions

1. **Type generation**: Should we generate `.d.ts` files from JSON schemas for developer DX?

2. **Component extensibility**: How do users add custom components to the catalog?

3. **Cross-workspace references**: Can workspace A reference data from workspace B?

4. **Offline AI**: Could schema/UI generation work with local models?

5. **Collaboration**: Multiple users editing the same schema simultaneously?

---

## Inspiration & Prior Art

- **json-render** (Vercel Labs): Guardrailed AI → UI generation
- **Notion**: Flexible schemas, but cloud-locked
- **Obsidian**: Local-first files, but unstructured
- **Retool**: Low-code UI builder, but SaaS
- **Directus**: Headless CMS with dynamic schemas
- **PocketBase**: SQLite backend with admin UI

---

## Summary

This specification outlines a system where:

1. **AI generates JSON schemas** defining data structure
2. **AI generates JSON interfaces** defining UI layout
3. **Yjs persists user data** with conflict-free sync
4. **Everything is local files** the user fully owns

The result: **Natural language to complete local-first applications.**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   "Create a habit tracker"                                                  │
│                                                                             │
│                          ═══════════════════▶                               │
│                                                                             │
│   ~/.epicenter/workspaces/habit-tracker/                                    │
│   ├── schema.json     ← Your data structure                                 │
│   ├── ui.json         ← Your interface                                      │
│   ├── data.yjs        ← Your data                                           │
│   └── data.db         ← Your queries                                        │
│                                                                             │
│   Grep it. Back it up. Move it anywhere. It's yours.                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```
