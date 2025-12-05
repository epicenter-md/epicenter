# Journal Workspace

**Date**: 2025-11-10T16:00:00
**Status**: Planning

## Overview

Create a new `journal.workspace.ts` workspace specifically for journal entries. This will separate personal journal content from general pages, providing a cleaner schema focused on temporal, reflective writing.

## Context

Currently, journal entries are stored in the `pages` workspace under folders like:
- `_family_and_carrie_journal`
- `_functional_journal`
- Other journal-type folders

These entries have different needs than blog posts or articles. They're more personal, temporal, and don't need heavy publishing metadata.

## Analysis of Current Journal Entries

Looking at existing journal entries in `EpicenterHQ/pages`:

**Common fields:**
- `id`: Unique identifier
- `title`: Entry title
- `content`: The journal entry body
- `date`: When written (with timezone)
- `timezone`: Timezone info
- `updated_at`: Last modified
- `type`: Category array (currently folder-based like `_family_and_carrie_journal`)
- `resonance`: Optional mood/feeling indicator (e.g., "Mild")

**Fields they DON'T need:**
- Publishing metadata (url, visibility, status)
- Multi-publishing tracking (status_transcripts_complete)
- Heavy categorization for public content

## Proposed Schema

```typescript
{
  journal_entries: {
    // Core identification
    id: id(),
    title: text(),
    content: text(),

    // Temporal metadata
    date: date(),
    timezone: text(),
    created_at: date({ nullable: true }),
    updated_at: date({ nullable: true }),

    // Categorization
    journal_type: select({
      options: ['family', 'friends', 'personal'],
      nullable: true,
    }),

    tags: tags({
      options: [
        'Yale',
        'Carrie',
        'Family',
        'Coding',
        'Productivity',
        'Travel',
        'Relationships',
        'Work',
        'Health',
        'Learning',
      ],
      nullable: true,
    }),

    // Emotional/reflective metadata
    mood: select({
      options: [
        'joyful',      // happy, high energy positive
        'content',     // peaceful, satisfied, low energy positive
        'contemplative', // reflective, thinking
        'neutral',     // just fine, neither good nor bad
        'melancholic', // sad, wistful
        'frustrated',  // annoyed, blocked
        'anxious',     // worried, nervous
      ],
      nullable: true,
    }),

    resonance: select({
      options: ['High', 'Medium', 'Mild', 'Low'],
      nullable: true,
    }),

    // Context
    location: text({ nullable: true }),

    // Meal tracking
    meal: select({
      options: ['breakfast', 'lunch', 'dinner', 'snack'],
      nullable: true,
    }),
  }
}
```

## Todo List

- [ ] Create `journal` folder in `examples/content-hub/`
- [ ] Create `journal.workspace.ts` file with schema
- [ ] Add standard workspace actions (CRUD operations)
- [ ] Add migration action `migrateFromEpicenterMd` to import existing journal entries
- [ ] Test migration with dry run
- [ ] Update `epicenter.config.ts` to include the new workspace
- [ ] Document the journal workspace in README

## Implementation Notes

1. **Keep it simple**: Journal entries are personal and temporal. The schema should be minimal and focused.

2. **Single journal type**: Use regular `select` for journal_type since each entry should have one primary category.

3. **Mood tracking**: 7 mutually exclusive mood options covering the emotional spectrum from high-energy positive to anxious.

4. **Migration strategy**: The migration will:
   - Filter files from journal-specific folders (`_family_and_carrie_journal`, `_functional_journal`)
   - Transform the `type` array to `journal_type` (mapping folder names to cleaner categories)
   - Preserve all temporal and content data
   - Use the same date transformation logic from pages workspace

5. **No publishing metadata**: Unlike pages, journals don't need url, visibility, or status fields. They're private by default.

## Review

_To be filled after implementation_
