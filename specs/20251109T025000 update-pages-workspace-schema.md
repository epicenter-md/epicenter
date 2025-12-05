# Update Pages Workspace Schema

**Date**: 2025-11-09T02:50:00
**Status**: Planning

## Summary

Update the `pages.workspace.ts` schema in the content-hub example to properly model the page structure used in `EpicenterHQ`, preparing for a future migration. The current schema is overly simplified and doesn't capture the rich metadata structure used in the actual pages.

## Current State

### Current Schema (pages.workspace.ts)
```typescript
schema: {
  pages: {
    id: id(),
    title: text(),
    content: text(),
    type: select({
      options: ['blog', 'article', 'guide', 'tutorial', 'news'],
    }),
    tags: select({
      options: ['tech', 'lifestyle', 'business', 'education', 'entertainment'],
    }),
  },
}
```

### Actual Schema (EpicenterHQ/epicenter.config.md.ts)
The real schema includes:
- **Basic fields**: id, title, content, subtitle
- **Timestamps**: created_at, updated_at, date (with timezone support)
- **Status tracking**: status, status_transcripts_complete
- **Categorization**: type (multiSelect), tags (multiSelect)
- **Publishing**: url, visibility, resonance

## Analysis of Actual Pages

From examining 10+ markdown files in `/Users/braden/Code/EpicenterHQ/pages/`:

### Common Frontmatter Fields
```yaml
id: 006dte137cojin56iv5pr
created_at: '2025-06-29T17:18:53.094Z'
date: '2025-06-29T17:18:53.093Z'
'on': []
status: Needs Scaffolding
status_transcripts_complete: 'TRUE'
subtitle: ''
timezone: America/Los_Angeles
title: 'Page title here'
type: []
updated_at: '2025-06-29T17:19:35.790Z'
resonance: 'Moderate'
url: 'https://example.com'
visibility: 'public'
```

### Field Usage Patterns
1. **Status values**: Needs Scaffolding, Needs Polishing, Backlog, Draft, Published, Archived
2. **Type values**: Includes underscore-prefixed categories (_misc, _family_and_carrie_journal, etc.) AND content types (blog, article, etc.)
3. **Tags values**: Yale, Advice/Original, Epicenter, YC, College Students, etc.
4. **Note**: The `'on'` field appears in markdown files but seems to map to the `tags` concept

## Target Schema Design

Based on the epicenter.config.md.ts file (lines 28-103), here's what we need:

```typescript
schema: {
  pages: {
    // Core fields
    id: id(),
    title: text(),
    content: text(),
    subtitle: text({ nullable: true }),

    // Timestamps with timezone support
    created_at: date({ nullable: true }),
    updated_at: date({ nullable: true }),
    date: date({ nullable: true }),
    timezone: text({ nullable: true }),

    // Status tracking
    status: select({
      options: [
        'Needs Scaffolding',
        'Needs Polishing',
        'Backlog',
        'Draft',
        'Published',
        'Archived',
      ],
      nullable: true,
    }),
    status_transcripts_complete: select({
      options: ['TRUE', 'FALSE'],
      nullable: true,
    }),

    // Categorization (tags allows multiple values)
    type: tags({
      options: [
        // Folder-based categories
        '_misc',
        '_family_and_carrie_journal',
        '_frontend_coding_tips',
        '_functional_journal',
        '_gap_thesis',
        '_janktable_revamp',
        '_video_comments',
        '_video_excerpts',
        '_yale_meals',
        '_yale_tales',
        '_Epicenter_Progress',
        '_my_favorite_foods',
        '_notable_yale_alumni',
        '_misc_false',
        // Content types
        'blog',
        'article',
        'guide',
        'tutorial',
        'news',
      ],
      nullable: true,
    }),

    tags: tags({
      options: [
        'Yale',
        'Advice/Original',
        'Epicenter',
        'YC',
        'College Students',
        'High School Students',
        'Coding',
        'Productivity',
        'Ethics',
        'Writing',
        'Tech',
        'Lifestyle',
        'Business',
        'Education',
        'Entertainment',
      ],
      nullable: true,
    }),

    // Publishing metadata
    url: text({ nullable: true }),
    visibility: select({
      options: ['public', 'private', 'unlisted'],
      nullable: true,
    }),
    resonance: text({ nullable: true }),
  },
}
```

## Key Differences

### 1. Date Handling
- **Before**: No date fields
- **After**: `created_at`, `updated_at`, `date` (all with timezone support)

### 2. Select vs Tags
- **Before**: `type` and `tags` were single-select
- **After**: Both use `tags()`, allowing pages to have multiple types/tags

### 3. Status Tracking
- **Before**: No status tracking
- **After**: Two status fields for workflow management

### 4. Publishing Metadata
- **Before**: No URL or visibility controls
- **After**: URL, visibility, and resonance fields

### 5. Richer Type Options
- **Before**: 5 simple content types
- **After**: 19 options including folder-based categories and content types

### 6. Expanded Tags
- **Before**: 5 generic tags
- **After**: 15 specific, niche-focused tags

## Implementation Plan

- [ ] Update schema definition in pages.workspace.ts
- [ ] Keep existing actions (they should work with the updated schema)
- [ ] Add JSDoc comments explaining the purpose of new fields
- [ ] Consider adding helper actions for common queries:
  - [ ] Get pages by status
  - [ ] Get pages by type
  - [ ] Get pages by tag
  - [ ] Get published pages only
- [ ] Test with sample data to ensure compatibility

## Notes

- The `'on'` field in actual markdown frontmatter likely maps to the `tags` field conceptually
- The underscore-prefixed types (like `_misc`) represent folder-based organization
- The schema maintains backward compatibility by making all new fields nullable
- The tags pattern is crucial for proper categorization (pages can belong to multiple categories)

## Migration Considerations

When migrating from EpicenterHQ:
1. Map frontmatter fields directly (1:1 mapping for most fields)
2. Handle the `'on'` field → might need to map to `tags`
3. Preserve all timestamps and timezone information
4. Maintain status tracking for workflow
5. Handle content_draft field if present (some pages have this)

## Review

Once implementation is complete, verify:
- [ ] Schema matches epicenter.config.md.ts structure
- [ ] All field types are correct (date, text, select, multiSelect)
- [ ] Nullable fields are properly marked
- [ ] Options arrays match actual usage in EpicenterHQ
- [ ] Actions work with the new schema
- [ ] Sample pages can be created with the new schema
