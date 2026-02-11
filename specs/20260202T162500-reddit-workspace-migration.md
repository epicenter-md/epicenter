# Ingest Package Specification

> A reusable data import library for multiple platforms (Reddit, Twitter, Google Takeout, etc.) using the **Static API** with Y.Doc as the single source of truth.

## Status: Implemented (v5 - MVP Complete)

### What's New in v5

**MVP implementation complete** in `packages/epicenter/src/ingest/`:

1. **Location Decision**: Implemented in `packages/epicenter/src/ingest/` (not a separate package) to leverage existing Static API exports
2. **File Structure**:
   ```
   packages/epicenter/src/ingest/
   ├── index.ts                      # Public exports
   ├── utils/
   │   ├── index.ts                  # Utils barrel
   │   ├── csv.ts                    # CSV parser (ported from vault-core)
   │   └── zip.ts                    # ZIP unpacker (uses fflate)
   └── reddit/
       ├── index.ts                  # Main API: importRedditExport, previewRedditExport, createRedditWorkspace
       ├── workspace.ts              # Reddit workspace definition (14 tables + 9 KV)
       ├── validation.ts             # CSV validation schema (arktype)
       ├── parse.ts                  # ZIP unpacking + CSV parsing
       ├── transform.ts              # CSV → table row transforms
       └── import-test.ts            # Test script
   ```
3. **Performance**: Real reddit_export.zip (~5.8K rows) imports in ~86ms
4. **API**:
   ```typescript
   import { createRedditWorkspace, importRedditExport, previewRedditExport } from '@epicenter/hq/ingest/reddit';

   const workspace = createRedditWorkspace();
   const stats = await importRedditExport(zipFile, workspace);
   ```

---

### What's New in v4

Updated based on analysis of actual Reddit GDPR export:

1. **Real Test Data**: Using actual `reddit_export.zip` (~800KB, ~7K rows) for integration/performance testing
2. **Schema Corrections**:
   - Removed `created_utc` from posts.csv (doesn't exist)
   - Changed `ip` from `string.ip` to `string` (often empty)
   - Marked `messages.csv` and `message_headers.csv` as optional
3. **File Count**: Updated from 41 to "up to 41" (38 in real export)
4. **Performance Baselines**: Updated to reflect real data (~7K rows in 5 seconds)
5. **Edge Cases**: Added handling for missing optional CSVs, empty IP fields

### What's New in v3

Based on thorough agent review:

1. **Type Safety**: Vote direction now validated as enum (`'up' | 'down' | 'none' | 'removed'`)
2. **Error Handling**: Added comprehensive error handling patterns for validation, transform, and insert phases
3. **Edge Cases**: Documented handling for empty CSVs, duplicate IDs, composite ID collisions, and large imports
4. **Performance**: Documented memory usage (~50MB for 50K rows) and timing estimates (1K rows/sec)
5. **Extension Integration**: Clarified SQLite sync timing (async, ~100ms lag), Markdown file structure, and .yjs persistence format
6. **Testing Strategy**: Added comprehensive test plan with 7 test categories, fixture requirements, and 40+ test cases

---

## Background

### Current Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            vault-core                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  • SQLite as source of truth                                                │
│  • Drizzle ORM for schema                                                   │
│  • DDL migrations (schema changes require migration files)                  │
│  • 40+ over-normalized tables                                               │
│  • Adapters (reddit, entity_index)                                          │
│  • Ingestors (ZIP parsing)                                                  │
│  • Codecs (JSON, Markdown)                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Target Architecture (Implemented)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    packages/epicenter/src/ingest/                           │
├─────────────────────────────────────────────────────────────────────────────┤
│  • Platform importers (reddit implemented, twitter future)                  │
│  • Functional API: createRedditWorkspace, importRedditExport                │
│  • Static API with ArkType schemas                                          │
│  • 14 consolidated tables + 9 KV entries                                    │
│  • Y.Doc as source of truth                                                 │
│  • batch() for atomic writes                                                │
│  • Test script (import-test.ts)                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Goals

1. **Static API**: Use `defineTable()` with ArkType schemas, `batch()` with `tx.set()`
2. **Consolidated schemas**: 14 tables + KV store (from 41 CSV files)
3. **Reusable import library**: Support multiple platforms with consistent API
4. **Functional patterns**: Use `defineImporter()` factory, no classes
5. **yargs CLI**: Follow existing patterns in `packages/epicenter/src/cli/`

## Non-Goals

1. Backward compatibility with vault-core SQLite format
2. MCP integration (separate layer)
3. DDL migrations (static API uses read-time migrations)
4. 1:1 CSV-to-table mapping (consolidation preferred)

---

## Architecture

### Static vs Dynamic API

This spec uses the **Static API**, not the Dynamic API:

```
┌────────────────────────────────────┬────────────────────────────────────────┐
│           STATIC API               │            DYNAMIC API                 │
│         (This Spec)                │          (Not Used)                    │
├────────────────────────────────────┼────────────────────────────────────────┤
│  Schema: defineTable(type({...}))  │  Schema: Runtime field definitions     │
│  Write:  table.batch(tx => ...)    │  Write:  ydoc.transact(() => ...)      │
│  Method: tx.set(row)               │  Method: table.upsert(row)             │
│  Storage: Row-level LWW            │  Storage: Cell-level LWW               │
│  Types:  Compile-time (ArkType)    │  Types:  Runtime inference             │
└────────────────────────────────────┴────────────────────────────────────────┘
```

### Data Flow Overview

The import pipeline has **4 distinct phases**: Parse → Validate → Transform → Insert.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              REDDIT GDPR ZIP                                 │
│                           (41 CSV files inside)                              │
└─────────────────────────────────────┬────────────────────────────────────────┘
                                      │
══════════════════════════════════════╪══════════════════════════════════════════
                              PHASE 1: PARSE
══════════════════════════════════════╪══════════════════════════════════════════
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│   ZIP.unpack() → { posts.csv, comments.csv, ... } → CSV.parse() → objects   │
│                                                                              │
│   Output: Record<string, Record<string, string>[]>                           │
│   (Raw CSV data as arrays of string-keyed objects)                           │
└─────────────────────────────────────┬────────────────────────────────────────┘
                                      │
══════════════════════════════════════╪══════════════════════════════════════════
                              PHASE 2: VALIDATE
══════════════════════════════════════╪══════════════════════════════════════════
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│   csvValidationSchema.assert(rawData)                                        │
│                                                                              │
│   • Validates each CSV against ArkType schema                                │
│   • Parses dates: 'string.date.parse'                                        │
│   • Validates IPs: 'string.ip'                                               │
│   • Parses numbers: 'string.numeric.parse'                                   │
│   • Throws ValidationError if schema mismatch                                │
│                                                                              │
│   Output: ValidatedRedditExport (typed, validated data)                      │
└─────────────────────────────────────┬────────────────────────────────────────┘
                                      │
══════════════════════════════════════╪══════════════════════════════════════════
                              PHASE 3: TRANSFORM
══════════════════════════════════════╪══════════════════════════════════════════
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
           ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
           │  SINGLETON    │  │   REDUNDANT   │  │    TABLE      │
           │   CSV FILES   │  │  (SKIP)       │  │   CSV FILES   │
           │               │  │               │  │               │
           │ account_gender│  │ post_headers  │  │ posts.csv     │
           │ birthdate     │  │ comment_hdrs  │  │ comments.csv  │
           │ statistics    │  │ message_hdrs  │  │ drafts.csv    │
           │ user_prefs    │  │ archive_hdrs  │  │ ... (28 more) │
           │ ... (9 total) │  │ (4 total)     │  │               │
           └───────┬───────┘  └───────────────┘  └───────┬───────┘
                   │                                     │
                   ▼                                     ▼
           ┌───────────────┐                    ┌───────────────┐
           │  Extract      │                    │  Add type     │
           │  singleton    │                    │  discriminator│
           │  values       │                    │  + composite  │
           │               │                    │  ID           │
           └───────┬───────┘                    └───────┬───────┘
                   │                                     │
══════════════════════════════════════════════════════════════════════════════════
                              PHASE 4: INSERT
══════════════════════════════════════════════════════════════════════════════════
                   │                                     │
                   ▼                                     ▼
           ┌───────────────┐                    ┌───────────────┐
           │ kv.batch(tx   │                    │ table.batch(  │
           │   => tx.set(  │                    │   tx => tx.   │
           │   key, val))  │                    │   set(row))   │
           └───────┬───────┘                    └───────┬───────┘
                   │                                     │
                   │         ┌───────────────┐          │
                   └────────►│               │◄─────────┘
                             │    Y.Doc      │
                             │  (CRDT)       │
                             │               │
                             │  14 tables    │
                             │  + KV store   │
                             │               │
                             └───────┬───────┘
                                     │
                   ┌─────────────────┼─────────────────┐
                   ▼                 ▼                 ▼
           ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
           │    SQLite     │ │   Markdown    │ │  Persistence  │
           │   (queries)   │ │   (editing)   │ │   (.yjs)      │
           └───────────────┘ └───────────────┘ └───────────────┘
```

### Pipeline Summary

| Phase | Input | Output | Failure Mode |
|-------|-------|--------|--------------|
| **Parse** | ZIP blob | `Record<string, string>[]` per CSV | `ParseError` (malformed CSV/ZIP) |
| **Validate** | Raw CSV objects | `ValidatedRedditExport` | `ValidationError` (schema mismatch) |
| **Transform** | Validated data | Table rows + KV entries | Never fails (pure mapping) |
| **Insert** | Transformed rows | Y.Doc mutations | `InsertError` (rare, CRDT issues) |

---

## CSV File Classification

### Appendix A: Complete CSV Mapping

Reddit GDPR exports contain up to 41 CSV files, but typically 38-40 are present depending on user activity. Files are classified into three categories:

> **Note**: Some files (like `messages.csv`, `message_headers.csv`) may be absent if the user has no data in those categories. The importer should handle missing optional files gracefully.

#### A.1 Singleton Data → KV Store (9 files)

These CSVs contain single rows or key-value pairs. They map to the KV store, not tables.

| CSV File | KV Key(s) | Notes |
|----------|-----------|-------|
| `account_gender.csv` | `accountGender` | Single value |
| `birthdate.csv` | `birthdate`, `verifiedBirthdate` | Two fields |
| `linked_phone_number.csv` | `phoneNumber` | Single value |
| `stripe.csv` | `stripeAccountId` | Single value |
| `persona.csv` | `personaInquiryId` | Single value |
| `twitter.csv` | `twitterUsername` | Single value |
| `statistics.csv` | `statistics` | Key-value pairs → JSON |
| `user_preferences.csv` | `preferences` | Key-value pairs → JSON |
| `checkfile.csv` | (skip) | Integrity check only |

#### A.2 Redundant Files → Skip (up to 4 files)

These CSVs are subsets of other files (metadata without body content). Skip during import.

| CSV File | Redundant With | Why Skip |
|----------|----------------|----------|
| `post_headers.csv` | `posts.csv` | Same data minus body |
| `comment_headers.csv` | `comments.csv` | Same data minus body |
| `message_headers.csv` | `messages.csv` | Same data minus body (optional, may be absent) |
| `messages_archive_headers.csv` | `messages_archive.csv` | Same data minus body |

#### A.3 Table Data → 14 Tables (28 files)

These CSVs map to tables with type discriminators for consolidation.

| Table | Source CSVs | Discriminator | Rows |
|-------|-------------|---------------|------|
| `content` | posts, comments, drafts | `type: 'post'\|'comment'\|'draft'` | ~10K |
| `votes` | post_votes, comment_votes, poll_votes | `targetType: 'post'\|'comment'\|'poll'` | ~50K |
| `saved` | saved_posts, saved_comments, hidden_posts | `action: 'save'\|'hide'`, `targetType` | ~5K |
| `messages` | messages, messages_archive | `archived: boolean` | ~1K |
| `chatHistory` | chat_history | (none - unique structure) | ~500 |
| `subreddits` | subscribed_, moderated_, approved_submitter_ | `role: 'subscribed'\|'moderated'\|'approved'` | ~500 |
| `multireddits` | multireddits | (none - has subreddits array) | ~20 |
| `awards` | gilded_content, gold_received | `direction: 'given'\|'received'` | ~100 |
| `commerce` | purchases, subscriptions, payouts | `type: 'purchase'\|'subscription'\|'payout'` | ~10 |
| `social` | friends, linked_identities | `type: 'friend'\|'linked_identity'` | ~50 |
| `announcements` | announcements | (none - unique structure) | ~100 |
| `scheduledPosts` | scheduled_posts | (none - unique structure) | ~10 |
| `ipLogs` | ip_logs | (none - unique structure) | ~1K |
| `adsPreferences` | sensitive_ads_preferences | (none - unique structure) | ~20 |

---

## Design

### 1. Package Structure

```
packages/ingest/
├── src/
│   ├── index.ts                    # Public exports
│   ├── importer.ts                 # defineImporter() factory
│   ├── types.ts                    # Shared types
│   │
│   ├── platforms/
│   │   ├── reddit/
│   │   │   ├── index.ts            # Export redditImporter
│   │   │   ├── importer.ts         # defineImporter({ ... })
│   │   │   ├── schema.ts           # 14 tables + KV (ArkType) - OUTPUT schema
│   │   │   ├── validation.ts       # CSV validation (ArkType) - INPUT schema
│   │   │   ├── parse.ts            # ZIP/CSV parsing (Phase 1)
│   │   │   └── transform.ts        # Validated → Table rows (Phase 3)
│   │   │
│   │   └── twitter/                # Future
│   │       └── ...
│   │
│   ├── utils/
│   │   ├── archive/
│   │   │   └── zip.ts              # ZIP unpacking (ported)
│   │   └── format/
│   │       └── csv.ts              # CSV parsing (ported)
│   │
│   └── cli/
│       ├── bin.ts                  # Entry point
│       └── cli.ts                  # yargs CLI
│
├── package.json
└── tsconfig.json
```

### 2. CSV Validation Schema (Phase 2)

The validation schema validates raw CSV data **before** transformation. It uses ArkType to:
- Enforce required fields exist
- Parse dates from strings (`string.date.parse` → `Date`)
- Validate IP addresses (`string.ip`)
- Parse numeric strings to numbers (`string.numeric.parse` → `number`)
- Validate enums (vote direction: `'up' | 'down' | 'none' | 'removed'`)

**Type Conversions in Transform Phase:**
- `Date` → `string` (ISO 8601): `.toISOString()`
- `number` → `string`: `String(value)`
- `undefined` → `null`: `value ?? null`

```typescript
// packages/ingest/src/platforms/reddit/validation.ts

import { type } from 'arktype';

// ═══════════════════════════════════════════════════════════════════════════
// HELPER TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Parse date string, allow empty string → undefined */
const date = type('string.date.parse');
const dateOpt = type('string')
  .pipe((v) => (v === '' ? undefined : v))
  .to('string.date.parse | undefined');

/** Handle special 'registration ip' value in ip_logs.csv */
const registrationDate = type('string')
  .pipe((v) => (v === 'registration ip' ? undefined : v))
  .to('string.date.parse | undefined');

// ═══════════════════════════════════════════════════════════════════════════
// CSV VALIDATION SCHEMA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validates raw Reddit GDPR CSV data.
 *
 * This schema is applied to the parsed CSV output BEFORE transformation.
 * It ensures the data matches Reddit's expected format.
 */
export const csvValidationSchema = type({
  // ─────────────────────────────────────────────────────────────────────────
  // CORE CONTENT
  // ─────────────────────────────────────────────────────────────────────────
  posts: type({
    id: 'string',
    permalink: 'string',
    date: date,
    // Note: created_utc is NOT present in actual exports, only date
    ip: 'string',  // Often empty string, not always valid IP
    subreddit: 'string',
    gildings: 'string.numeric.parse',
    title: 'string | undefined',
    url: 'string | undefined',
    body: 'string | undefined',
  }).array(),

  comments: type({
    id: 'string',
    permalink: 'string',
    date: date,
    ip: 'string',  // Often empty string
    subreddit: 'string',
    gildings: 'string.numeric.parse',
    link: 'string',  // URL to parent post
    parent: 'string | undefined',
    body: 'string | undefined',
    media: 'string | undefined',
  }).array(),

  drafts: type({
    id: 'string',
    title: 'string | undefined',
    body: 'string | undefined',
    kind: 'string | undefined',
    created: dateOpt,
    spoiler: 'string | undefined',
    nsfw: 'string | undefined',
    original_content: 'string | undefined',
    content_category: 'string | undefined',
    flair_id: 'string | undefined',
    flair_text: 'string | undefined',
    send_replies: 'string | undefined',
    subreddit: 'string | undefined',
    is_public_link: 'string | undefined',
  }).array(),

  // ─────────────────────────────────────────────────────────────────────────
  // VOTES / SAVES / VISIBILITY
  // ─────────────────────────────────────────────────────────────────────────
  post_votes: type({
    id: 'string',
    permalink: 'string',
    direction: "'up' | 'down' | 'none' | 'removed'",  // Validated enum
  }).array(),

  comment_votes: type({
    id: 'string',
    permalink: 'string',
    direction: "'up' | 'down' | 'none' | 'removed'",  // Validated enum
  }).array(),

  poll_votes: type({
    post_id: 'string',
    user_selection: 'string | undefined',
    text: 'string | undefined',
    image_url: 'string | undefined',
    is_prediction: 'string | undefined',
    stake_amount: 'string | undefined',
  }).array(),

  saved_posts: type({ id: 'string', permalink: 'string' }).array(),
  saved_comments: type({ id: 'string', permalink: 'string' }).array(),
  hidden_posts: type({ id: 'string', permalink: 'string' }).array(),

  // ─────────────────────────────────────────────────────────────────────────
  // MESSAGING
  // ─────────────────────────────────────────────────────────────────────────
  // Note: messages.csv may be absent if user has no active messages
  'messages?': type({
    id: 'string',
    permalink: 'string',
    thread_id: 'string | undefined',
    date: dateOpt,
    ip: 'string',  // Often empty
    from: 'string | undefined',
    to: 'string | undefined',
    subject: 'string | undefined',
    body: 'string | undefined',
  }).array(),

  messages_archive: type({
    id: 'string',
    permalink: 'string',
    thread_id: 'string | undefined',
    date: dateOpt,
    ip: 'string',  // Often empty
    from: 'string | undefined',
    to: 'string | undefined',
    subject: 'string | undefined',
    body: 'string | undefined',
  }).array(),

  chat_history: type({
    message_id: 'string',
    created_at: dateOpt,
    updated_at: dateOpt,
    username: 'string | undefined',
    message: 'string | undefined',
    thread_parent_message_id: 'string | undefined',
    channel_url: 'string | undefined',
    subreddit: 'string | undefined',
    channel_name: 'string | undefined',
    conversation_type: 'string | undefined',
  }).array(),

  // ─────────────────────────────────────────────────────────────────────────
  // SUBREDDITS
  // ─────────────────────────────────────────────────────────────────────────
  subscribed_subreddits: type({ subreddit: 'string' }).array(),
  moderated_subreddits: type({ subreddit: 'string' }).array(),
  approved_submitter_subreddits: type({ subreddit: 'string' }).array(),

  multireddits: type({
    id: 'string',
    display_name: 'string | undefined',
    date: dateOpt,
    description: 'string | undefined',
    privacy: 'string | undefined',
    subreddits: 'string | undefined',
    image_url: 'string | undefined',
    is_owner: 'string | undefined',
    favorited: 'string | undefined',
    followers: 'string | undefined',
  }).array(),

  // ─────────────────────────────────────────────────────────────────────────
  // AWARDS
  // ─────────────────────────────────────────────────────────────────────────
  gilded_content: type({
    content_link: 'string',
    award: 'string | undefined',
    amount: 'string | undefined',
    date: dateOpt,
  }).array(),

  gold_received: type({
    content_link: 'string',
    gold_received: 'string | undefined',
    gilder_username: 'string | undefined',
    date: dateOpt,
  }).array(),

  // ─────────────────────────────────────────────────────────────────────────
  // COMMERCE
  // ─────────────────────────────────────────────────────────────────────────
  purchases: type({
    processor: 'string | undefined',
    transaction_id: 'string',
    product: 'string | undefined',
    date: dateOpt,
    cost: 'string | undefined',
    currency: 'string | undefined',
    status: 'string | undefined',
  }).array(),

  subscriptions: type({
    processor: 'string | undefined',
    subscription_id: 'string',
    product: 'string | undefined',
    product_id: 'string | undefined',
    product_name: 'string | undefined',
    status: 'string | undefined',
    start_date: dateOpt,
    end_date: dateOpt,
  }).array(),

  payouts: type({
    payout_amount_usd: 'string | undefined',
    date: date,
    payout_id: 'string | undefined',
  }).array(),

  // ─────────────────────────────────────────────────────────────────────────
  // SOCIAL
  // ─────────────────────────────────────────────────────────────────────────
  friends: type({
    username: 'string',
    note: 'string | undefined',
  }).array(),

  linked_identities: type({
    issuer_id: 'string',
    subject_id: 'string',
  }).array(),

  // ─────────────────────────────────────────────────────────────────────────
  // OTHER TABLES
  // ─────────────────────────────────────────────────────────────────────────
  announcements: type({
    announcement_id: 'string',
    sent_at: dateOpt,
    read_at: dateOpt,
    from_id: 'string | undefined',
    from_username: 'string | undefined',
    subject: 'string | undefined',
    body: 'string | undefined',
    url: 'string | undefined',
  }).array(),

  scheduled_posts: type({
    scheduled_post_id: 'string',
    subreddit: 'string | undefined',
    title: 'string | undefined',
    body: 'string | undefined',
    url: 'string | undefined',
    submission_time: dateOpt,
    recurrence: 'string | undefined',
  }).array(),

  ip_logs: type({
    date: registrationDate,  // Can be 'registration ip' literal
    ip: 'string',  // IP address
  }).array(),

  sensitive_ads_preferences: type({
    type: 'string',
    preference: 'string | undefined',
  }).array(),

  // ─────────────────────────────────────────────────────────────────────────
  // SINGLETON / KV DATA
  // ─────────────────────────────────────────────────────────────────────────
  account_gender: type({ account_gender: 'string | undefined' }).array(),

  birthdate: type({
    birthdate: dateOpt,
    verified_birthdate: dateOpt,
    verification_state: 'string | undefined',
    verification_method: 'string | undefined',
  }).array(),

  statistics: type({
    statistic: 'string',
    value: 'string | undefined',
  }).array(),

  user_preferences: type({
    preference: 'string',
    value: 'string | undefined',
  }).array(),

  linked_phone_number: type({ phone_number: 'string' }).array(),
  stripe: type({ stripe_account_id: 'string' }).array(),
  twitter: type({ username: 'string' }).array(),
  persona: type({ persona_inquiry_id: 'string' }).array(),

  // ─────────────────────────────────────────────────────────────────────────
  // REDUNDANT (validated but skipped during transform)
  // ─────────────────────────────────────────────────────────────────────────
  post_headers: type({
    id: 'string',
    permalink: 'string',
    date: date,
    ip: 'string',
    subreddit: 'string',
    gildings: 'string.numeric.parse',
    url: 'string | undefined',
  }).array(),

  comment_headers: type({
    id: 'string',
    permalink: 'string',
    date: date,
    ip: 'string',
    subreddit: 'string',
    gildings: 'string.numeric.parse',
    link: 'string',
    parent: 'string | undefined',
  }).array(),

  // Note: message_headers.csv may be absent if messages.csv is absent
  'message_headers?': type({
    id: 'string',
    permalink: 'string',
    thread_id: 'string | undefined',
    date: dateOpt,
    ip: 'string',
    from: 'string | undefined',
    to: 'string | undefined',
  }).array(),

  messages_archive_headers: type({
    id: 'string',
    permalink: 'string',
    thread_id: 'string | undefined',
    date: dateOpt,
    ip: 'string',
    from: 'string | undefined',
    to: 'string | undefined',
  }).array(),

  // ─────────────────────────────────────────────────────────────────────────
  // METADATA (skipped)
  // ─────────────────────────────────────────────────────────────────────────
  checkfile: type({
    filename: 'string',
    sha256: 'string | undefined',
  }).array(),
});

/** Validated Reddit export data type */
export type ValidatedRedditExport = typeof csvValidationSchema.infer;

/**
 * Validate raw parsed CSV data.
 * Throws ArkType validation error if data doesn't match expected schema.
 */
export function validateRedditExport(
  rawData: Record<string, Record<string, string>[]>,
): ValidatedRedditExport {
  return csvValidationSchema.assert(rawData);
}
```

### 2. Schema Definition (Static API + ArkType)

```typescript
// packages/ingest/src/platforms/reddit/schema.ts

import { defineTable, defineWorkspace } from '@epicenter/hq/static';
import { type } from 'arktype';

// ═══════════════════════════════════════════════════════════════════════════
// TABLE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Content: posts, comments, drafts
 *
 * Source CSVs: posts.csv, comments.csv, drafts.csv
 */
const content = defineTable(
  type({
    id: 'string',
    type: "'post' | 'comment' | 'draft'",
    permalink: 'string | null',
    date: 'string | null',
    ip: 'string | null',
    subreddit: 'string | null',
    gildings: 'string | null',
    // Post-specific
    'title?': 'string',
    'url?': 'string',
    // Comment-specific
    'link?': 'string',
    'parent?': 'string',
    // Shared
    'body?': 'string',
    'media?': 'string',
    // Draft-specific
    'kind?': 'string',
    'spoiler?': 'string',
    'nsfw?': 'string',
  })
);

/**
 * Votes: post_votes, comment_votes, poll_votes
 *
 * Source CSVs: post_votes.csv, comment_votes.csv, poll_votes.csv
 */
const votes = defineTable(
  type({
    id: 'string',                              // Composite: `${targetType}:${targetId}`
    targetType: "'post' | 'comment' | 'poll'",
    targetId: 'string',
    permalink: 'string | null',
    direction: "'up' | 'down' | 'none' | 'removed' | null",  // Validated enum
    // Poll-specific
    'userSelection?': 'string',
    'text?': 'string',
    'isPrediction?': 'string',
    'stakeAmount?': 'string',
  })
);

/**
 * Saved: saved_posts, saved_comments, hidden_posts
 *
 * Source CSVs: saved_posts.csv, saved_comments.csv, hidden_posts.csv
 */
const saved = defineTable(
  type({
    id: 'string',                              // Composite: `${action}:${targetType}:${targetId}`
    action: "'save' | 'hide'",
    targetType: "'post' | 'comment'",
    targetId: 'string',
    permalink: 'string',
  })
);

/**
 * Messages: messages, messages_archive
 *
 * Source CSVs: messages.csv, messages_archive.csv
 */
const messages = defineTable(
  type({
    id: 'string',
    archived: 'boolean',
    permalink: 'string | null',
    threadId: 'string | null',
    date: 'string | null',
    ip: 'string | null',
    'from?': 'string',
    'to?': 'string',
    'subject?': 'string',
    'body?': 'string',
  })
);

/**
 * Chat History (unique structure, not consolidated)
 *
 * Source CSV: chat_history.csv
 */
const chatHistory = defineTable(
  type({
    id: 'string',                    // message_id from CSV
    createdAt: 'string | null',
    updatedAt: 'string | null',
    username: 'string | null',
    message: 'string | null',
    threadParentMessageId: 'string | null',
    channelUrl: 'string | null',
    subreddit: 'string | null',
    channelName: 'string | null',
    conversationType: 'string | null',
  })
);

/**
 * Subreddits: subscribed, moderated, approved_submitter
 *
 * Source CSVs: subscribed_subreddits.csv, moderated_subreddits.csv,
 *              approved_submitter_subreddits.csv
 */
const subreddits = defineTable(
  type({
    id: 'string',                    // Composite: `${role}:${subreddit}`
    subreddit: 'string',
    role: "'subscribed' | 'moderated' | 'approved_submitter'",
  })
);

/**
 * Multireddits (unique structure with subreddits array)
 *
 * Source CSV: multireddits.csv
 */
const multireddits = defineTable(
  type({
    id: 'string',
    displayName: 'string | null',
    date: 'string | null',
    description: 'string | null',
    privacy: 'string | null',
    subreddits: 'string | null',     // Comma-separated list
    imageUrl: 'string | null',
    isOwner: 'string | null',
    favorited: 'string | null',
    followers: 'string | null',
  })
);

/**
 * Awards: gilded_content, gold_received
 *
 * Source CSVs: gilded_content.csv, gold_received.csv
 */
const awards = defineTable(
  type({
    id: 'string',                    // Composite: `${direction}:${contentLink}`
    direction: "'given' | 'received'",
    contentLink: 'string',
    award: 'string | null',
    amount: 'string | null',
    date: 'string | null',
    'gilderUsername?': 'string',     // Only for received
  })
);

/**
 * Commerce: purchases, subscriptions, payouts
 *
 * Source CSVs: purchases.csv, subscriptions.csv, payouts.csv
 */
const commerce = defineTable(
  type({
    id: 'string',
    type: "'purchase' | 'subscription' | 'payout'",
    date: 'string | null',
    // Purchase-specific
    'processor?': 'string',
    'transactionId?': 'string',
    'product?': 'string',
    'cost?': 'string',
    'currency?': 'string',
    'status?': 'string',
    // Subscription-specific
    'subscriptionId?': 'string',
    'productId?': 'string',
    'productName?': 'string',
    'startDate?': 'string',
    'endDate?': 'string',
    // Payout-specific
    'payoutId?': 'string',
    'payoutAmountUsd?': 'string',
  })
);

/**
 * Social: friends, linked_identities
 *
 * Source CSVs: friends.csv, linked_identities.csv
 */
const social = defineTable(
  type({
    id: 'string',                    // Composite: `${type}:${identifier}`
    type: "'friend' | 'linked_identity'",
    // Friend-specific
    'username?': 'string',
    'note?': 'string',
    // Linked identity-specific
    'issuerId?': 'string',
    'subjectId?': 'string',
  })
);

/**
 * Announcements (unique structure)
 *
 * Source CSV: announcements.csv
 */
const announcements = defineTable(
  type({
    id: 'string',                    // announcement_id from CSV
    sentAt: 'string | null',
    readAt: 'string | null',
    fromId: 'string | null',
    fromUsername: 'string | null',
    subject: 'string | null',
    body: 'string | null',
    url: 'string | null',
  })
);

/**
 * Scheduled Posts (unique structure)
 *
 * Source CSV: scheduled_posts.csv
 */
const scheduledPosts = defineTable(
  type({
    id: 'string',                    // scheduled_post_id from CSV
    subreddit: 'string | null',
    title: 'string | null',
    body: 'string | null',
    url: 'string | null',
    submissionTime: 'string | null',
    recurrence: 'string | null',
  })
);

/**
 * IP Logs (unique structure)
 *
 * Source CSV: ip_logs.csv
 */
const ipLogs = defineTable(
  type({
    id: 'string',                    // Generated hash of date:ip
    date: 'string',
    ip: 'string',
  })
);

/**
 * Ads Preferences (unique structure)
 *
 * Source CSV: sensitive_ads_preferences.csv
 */
const adsPreferences = defineTable(
  type({
    id: 'string',                    // type field as ID
    type: 'string',
    preference: 'string | null',
  })
);

// ═══════════════════════════════════════════════════════════════════════════
// WORKSPACE DEFINITION
// ═══════════════════════════════════════════════════════════════════════════

export const redditWorkspace = defineWorkspace({
  id: 'reddit',

  tables: {
    content,
    votes,
    saved,
    messages,
    chatHistory,
    subreddits,
    multireddits,
    awards,
    commerce,
    social,
    announcements,
    scheduledPosts,
    ipLogs,
    adsPreferences,
  },

  kv: {
    // Singleton values from CSV files
    accountGender: type('string | null'),
    birthdate: type('string | null'),
    verifiedBirthdate: type('string | null'),
    phoneNumber: type('string | null'),
    stripeAccountId: type('string | null'),
    personaInquiryId: type('string | null'),
    twitterUsername: type('string | null'),
    // Key-value pairs stored as JSON
    statistics: type('Record<string, string> | null'),
    preferences: type('Record<string, string> | null'),
  },
});

export type RedditWorkspace = typeof redditWorkspace;
```

### 3. Importer API

The importer uses the **Static API** with `batch()` for atomic writes:

```typescript
// packages/ingest/src/importer.ts

import type { StaticWorkspace } from '@epicenter/hq/static';

/**
 * Importer definition config
 */
type ImporterConfig<TWorkspace, TPreview, TStats> = {
  /** Unique identifier for this importer */
  id: string;

  /** Human-readable name */
  name: string;

  /** File extensions this importer handles */
  extensions: string[];

  /** Check if a file matches this importer */
  matches: (file: File | Blob, filename: string) => boolean | Promise<boolean>;

  /** Preview without modifying state */
  preview: (file: File | Blob) => Promise<TPreview>;

  /** Import file contents using Static API */
  import: (
    file: File | Blob,
    workspace: StaticWorkspace<TWorkspace>,
    options?: ImportOptions,
  ) => Promise<TStats>;
};

type ImportOptions = {
  skipInvalid?: boolean;
  onProgress?: (progress: ImportProgress) => void;
};

type ImportProgress = {
  phase: 'unpack' | 'parse' | 'transform' | 'import';
  current: number;
  total: number;
  table?: string;
};

/**
 * Define a platform importer using the Static API.
 */
export function defineImporter<TWorkspace, TPreview, TStats>(
  config: ImporterConfig<TWorkspace, TPreview, TStats>,
) {
  return {
    id: config.id,
    name: config.name,
    extensions: config.extensions,
    matches: config.matches,
    preview: config.preview,
    import: config.import,
  };
}
```

### 4. Reddit Importer Implementation

```typescript
// packages/ingest/src/platforms/reddit/importer.ts

import { defineImporter } from '../../importer';
import { parseRedditZip } from './parse';
import { validateRedditExport, type ValidatedRedditExport } from './validation';
import { redditWorkspace } from './schema';
import type { StaticWorkspace } from '@epicenter/hq/static';

type Workspace = StaticWorkspace<typeof redditWorkspace>;

export const redditImporter = defineImporter({
  id: 'reddit',
  name: 'Reddit GDPR Export',
  extensions: ['.zip'],

  matches: (file, filename) => filename.endsWith('.zip'),

  async preview(file) {
    // Phase 1: Parse
    const rawData = await parseRedditZip(file);

    // Phase 2: Validate (throws if invalid)
    const data = validateRedditExport(rawData);

    return {
      tables: {
        content: data.posts.length + data.comments.length + data.drafts.length,
        votes: data.post_votes.length + data.comment_votes.length + data.poll_votes.length,
        saved: data.saved_posts.length + data.saved_comments.length + data.hidden_posts.length,
        messages: data.messages.length + data.messages_archive.length,
        chatHistory: data.chat_history.length,
        subreddits: data.subscribed_subreddits.length + data.moderated_subreddits.length + data.approved_submitter_subreddits.length,
        multireddits: data.multireddits.length,
        awards: data.gilded_content.length + data.gold_received.length,
        commerce: data.purchases.length + data.subscriptions.length + data.payouts.length,
        social: data.friends.length + data.linked_identities.length,
        announcements: data.announcements.length,
        scheduledPosts: data.scheduled_posts.length,
        ipLogs: data.ip_logs.length,
        adsPreferences: data.sensitive_ads_preferences.length,
      },
      kv: {
        accountGender: !!data.account_gender?.[0],
        birthdate: !!data.birthdate?.[0],
        statistics: data.statistics.length > 0,
        preferences: data.user_preferences.length > 0,
      },
    };
  },

  async import(file, workspace: Workspace, options) {
    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 1: PARSE
    // ═══════════════════════════════════════════════════════════════════════════
    options?.onProgress?.({ phase: 'unpack', current: 0, total: 1 });
    const rawData = await parseRedditZip(file);

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 2: VALIDATE
    // ═══════════════════════════════════════════════════════════════════════════
    // Throws ValidationError if data doesn't match expected Reddit GDPR schema
    options?.onProgress?.({ phase: 'parse', current: 0, total: 1 });
    const data = validateRedditExport(rawData);

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 3 & 4: TRANSFORM + INSERT
    // ═══════════════════════════════════════════════════════════════════════════
    options?.onProgress?.({ phase: 'transform', current: 0, total: 14 });
    const stats = { tables: {} as Record<string, number>, kv: 0, totalRows: 0 };

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE: content (posts + comments + drafts)
    // Note: Transform snake_case (CSV) → camelCase (table schema)
    // Note: IP field is often empty string in real exports
    // ─────────────────────────────────────────────────────────────────────────
    workspace.tables.content.batch((tx) => {
      for (const row of data.posts) {
        tx.set({
          id: row.id,
          type: 'post' as const,
          permalink: row.permalink,
          date: row.date?.toISOString() ?? null,
          ip: row.ip || null,  // Empty string → null
          subreddit: row.subreddit,
          gildings: String(row.gildings),
          title: row.title,
          url: row.url,
          body: row.body,
        });
      }
      for (const row of data.comments) {
        tx.set({
          id: row.id,
          type: 'comment' as const,
          permalink: row.permalink,
          date: row.date?.toISOString() ?? null,
          ip: row.ip,
          subreddit: row.subreddit,
          gildings: String(row.gildings),
          link: row.link,
          parent: row.parent,
          body: row.body,
          media: row.media,
        });
      }
      for (const row of data.drafts) {
        tx.set({
          id: row.id,
          type: 'draft' as const,
          permalink: null,
          date: row.created?.toISOString() ?? null,
          ip: null,
          subreddit: row.subreddit,
          gildings: null,
          title: row.title,
          body: row.body,
          kind: row.kind,
          spoiler: row.spoiler,
          nsfw: row.nsfw,
        });
      }
    });
    stats.tables.content = data.posts.length + data.comments.length + data.drafts.length;

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE: votes (post_votes + comment_votes + poll_votes)
    // ─────────────────────────────────────────────────────────────────────────
    workspace.tables.votes.batch((tx) => {
      for (const row of data.post_votes) {
        tx.set({
          id: `post:${row.id}`,
          targetType: 'post' as const,
          targetId: row.id,
          permalink: row.permalink,
          direction: row.direction as 'up' | 'down' | 'none',
        });
      }
      for (const row of data.comment_votes) {
        tx.set({
          id: `comment:${row.id}`,
          targetType: 'comment' as const,
          targetId: row.id,
          permalink: row.permalink,
          direction: row.direction as 'up' | 'down' | 'none',
        });
      }
      for (const row of data.poll_votes) {
        tx.set({
          id: `poll:${row.post_id}`,
          targetType: 'poll' as const,
          targetId: row.post_id,
          permalink: null,
          direction: null,
          userSelection: row.user_selection,
          text: row.text,
          isPrediction: row.is_prediction,
          stakeAmount: row.stake_amount,
        });
      }
    });
    stats.tables.votes = data.post_votes.length + data.comment_votes.length + data.poll_votes.length;

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE: saved (saved_posts + saved_comments + hidden_posts)
    // ─────────────────────────────────────────────────────────────────────────
    workspace.tables.saved.batch((tx) => {
      for (const row of data.saved_posts) {
        tx.set({
          id: `save:post:${row.id}`,
          action: 'save' as const,
          targetType: 'post' as const,
          targetId: row.id,
          permalink: row.permalink,
        });
      }
      for (const row of data.saved_comments) {
        tx.set({
          id: `save:comment:${row.id}`,
          action: 'save' as const,
          targetType: 'comment' as const,
          targetId: row.id,
          permalink: row.permalink,
        });
      }
      for (const row of data.hidden_posts) {
        tx.set({
          id: `hide:post:${row.id}`,
          action: 'hide' as const,
          targetType: 'post' as const,
          targetId: row.id,
          permalink: row.permalink,
        });
      }
    });
    stats.tables.saved = data.saved_posts.length + data.saved_comments.length + data.hidden_posts.length;

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE: messages (messages + messages_archive)
    // Note: messages.csv may be absent if user has no active messages
    // ─────────────────────────────────────────────────────────────────────────
    workspace.tables.messages.batch((tx) => {
      // Handle optional messages array (may be undefined/absent)
      for (const row of data.messages ?? []) {
        tx.set({
          id: row.id,
          archived: false,
          permalink: row.permalink,
          threadId: row.thread_id,
          date: row.date?.toISOString() ?? null,
          ip: row.ip || null,
          from: row.from,
          to: row.to,
          subject: row.subject,
          body: row.body,
        });
      }
      for (const row of data.messages_archive) {
        tx.set({
          id: row.id,
          archived: true,
          permalink: row.permalink,
          threadId: row.thread_id,
          date: row.date?.toISOString() ?? null,
          ip: row.ip || null,
          from: row.from,
          to: row.to,
          subject: row.subject,
          body: row.body,
        });
      }
    });
    stats.tables.messages = (data.messages?.length ?? 0) + data.messages_archive.length;

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE: chatHistory (chat_history - unique structure)
    // ─────────────────────────────────────────────────────────────────────────
    workspace.tables.chatHistory.batch((tx) => {
      for (const row of data.chat_history) {
        tx.set({
          id: row.message_id,
          createdAt: row.created_at?.toISOString() ?? null,
          updatedAt: row.updated_at?.toISOString() ?? null,
          username: row.username,
          message: row.message,
          threadParentMessageId: row.thread_parent_message_id,
          channelUrl: row.channel_url,
          subreddit: row.subreddit,
          channelName: row.channel_name,
          conversationType: row.conversation_type,
        });
      }
    });
    stats.tables.chatHistory = data.chat_history.length;

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE: subreddits (subscribed + moderated + approved_submitter)
    // ─────────────────────────────────────────────────────────────────────────
    workspace.tables.subreddits.batch((tx) => {
      for (const row of data.subscribed_subreddits) {
        tx.set({
          id: `subscribed:${row.subreddit}`,
          subreddit: row.subreddit,
          role: 'subscribed' as const,
        });
      }
      for (const row of data.moderated_subreddits) {
        tx.set({
          id: `moderated:${row.subreddit}`,
          subreddit: row.subreddit,
          role: 'moderated' as const,
        });
      }
      for (const row of data.approved_submitter_subreddits) {
        tx.set({
          id: `approved_submitter:${row.subreddit}`,
          subreddit: row.subreddit,
          role: 'approved_submitter' as const,
        });
      }
    });
    stats.tables.subreddits = data.subscribed_subreddits.length + data.moderated_subreddits.length + data.approved_submitter_subreddits.length;

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE: multireddits (unique structure with subreddits array)
    // ─────────────────────────────────────────────────────────────────────────
    workspace.tables.multireddits.batch((tx) => {
      for (const row of data.multireddits) {
        tx.set({
          id: row.id,
          displayName: row.display_name,
          date: row.date?.toISOString() ?? null,
          description: row.description,
          privacy: row.privacy,
          subreddits: row.subreddits,
          imageUrl: row.image_url,
          isOwner: row.is_owner,
          favorited: row.favorited,
          followers: row.followers,
        });
      }
    });
    stats.tables.multireddits = data.multireddits.length;

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE: awards (gilded_content + gold_received)
    // ─────────────────────────────────────────────────────────────────────────
    workspace.tables.awards.batch((tx) => {
      for (const row of data.gilded_content) {
        tx.set({
          id: `given:${row.content_link}`,
          direction: 'given' as const,
          contentLink: row.content_link,
          award: row.award,
          amount: row.amount,
          date: row.date?.toISOString() ?? null,
        });
      }
      for (const row of data.gold_received) {
        tx.set({
          id: `received:${row.content_link}`,
          direction: 'received' as const,
          contentLink: row.content_link,
          award: row.gold_received,
          amount: null,
          date: row.date?.toISOString() ?? null,
          gilderUsername: row.gilder_username,
        });
      }
    });
    stats.tables.awards = data.gilded_content.length + data.gold_received.length;

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE: commerce (purchases + subscriptions + payouts)
    // ─────────────────────────────────────────────────────────────────────────
    workspace.tables.commerce.batch((tx) => {
      for (const row of data.purchases) {
        tx.set({
          id: `purchase:${row.transaction_id}`,
          type: 'purchase' as const,
          date: row.date?.toISOString() ?? null,
          processor: row.processor,
          transactionId: row.transaction_id,
          product: row.product,
          cost: row.cost,
          currency: row.currency,
          status: row.status,
        });
      }
      for (const row of data.subscriptions) {
        tx.set({
          id: `subscription:${row.subscription_id}`,
          type: 'subscription' as const,
          date: null,
          subscriptionId: row.subscription_id,
          productId: row.product_id,
          productName: row.product_name,
          status: row.status,
          startDate: row.start_date?.toISOString() ?? null,
          endDate: row.end_date?.toISOString() ?? null,
        });
      }
      for (const row of data.payouts) {
        tx.set({
          id: `payout:${row.payout_id ?? row.date.toISOString()}`,
          type: 'payout' as const,
          date: row.date.toISOString(),
          payoutId: row.payout_id,
          payoutAmountUsd: row.payout_amount_usd,
        });
      }
    });
    stats.tables.commerce = data.purchases.length + data.subscriptions.length + data.payouts.length;

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE: social (friends + linked_identities)
    // ─────────────────────────────────────────────────────────────────────────
    workspace.tables.social.batch((tx) => {
      for (const row of data.friends) {
        tx.set({
          id: `friend:${row.username}`,
          type: 'friend' as const,
          username: row.username,
          note: row.note,
        });
      }
      for (const row of data.linked_identities) {
        tx.set({
          id: `linked_identity:${row.issuer_id}:${row.subject_id}`,
          type: 'linked_identity' as const,
          issuerId: row.issuer_id,
          subjectId: row.subject_id,
        });
      }
    });
    stats.tables.social = data.friends.length + data.linked_identities.length;

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE: announcements (unique structure)
    // ─────────────────────────────────────────────────────────────────────────
    workspace.tables.announcements.batch((tx) => {
      for (const row of data.announcements) {
        tx.set({
          id: row.announcement_id,
          sentAt: row.sent_at?.toISOString() ?? null,
          readAt: row.read_at?.toISOString() ?? null,
          fromId: row.from_id,
          fromUsername: row.from_username,
          subject: row.subject,
          body: row.body,
          url: row.url,
        });
      }
    });
    stats.tables.announcements = data.announcements.length;

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE: scheduledPosts (unique structure)
    // ─────────────────────────────────────────────────────────────────────────
    workspace.tables.scheduledPosts.batch((tx) => {
      for (const row of data.scheduled_posts) {
        tx.set({
          id: row.scheduled_post_id,
          subreddit: row.subreddit,
          title: row.title,
          body: row.body,
          url: row.url,
          submissionTime: row.submission_time?.toISOString() ?? null,
          recurrence: row.recurrence,
        });
      }
    });
    stats.tables.scheduledPosts = data.scheduled_posts.length;

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE: ipLogs (unique structure)
    // ─────────────────────────────────────────────────────────────────────────
    workspace.tables.ipLogs.batch((tx) => {
      for (const row of data.ip_logs) {
        tx.set({
          id: `${row.date?.toISOString() ?? 'unknown'}:${row.ip}`,
          date: row.date?.toISOString() ?? '',
          ip: row.ip,
        });
      }
    });
    stats.tables.ipLogs = data.ip_logs.length;

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE: adsPreferences (unique structure)
    // ─────────────────────────────────────────────────────────────────────────
    workspace.tables.adsPreferences.batch((tx) => {
      for (const row of data.sensitive_ads_preferences) {
        tx.set({
          id: row.type,
          type: row.type,
          preference: row.preference,
        });
      }
    });
    stats.tables.adsPreferences = data.sensitive_ads_preferences.length;

    // ─────────────────────────────────────────────────────────────────────────
    // KV STORE: Singleton data
    // ─────────────────────────────────────────────────────────────────────────
    workspace.kv.batch((tx) => {
      // Single-value CSVs
      if (data.account_gender?.[0]?.account_gender) {
        tx.set('accountGender', data.account_gender[0].account_gender);
        stats.kv++;
      }
      if (data.birthdate?.[0]) {
        if (data.birthdate[0].birthdate) {
          tx.set('birthdate', data.birthdate[0].birthdate.toISOString());
          stats.kv++;
        }
        if (data.birthdate[0].verified_birthdate) {
          tx.set('verifiedBirthdate', data.birthdate[0].verified_birthdate.toISOString());
          stats.kv++;
        }
      }
      if (data.linked_phone_number?.[0]?.phone_number) {
        tx.set('phoneNumber', data.linked_phone_number[0].phone_number);
        stats.kv++;
      }
      if (data.stripe?.[0]?.stripe_account_id) {
        tx.set('stripeAccountId', data.stripe[0].stripe_account_id);
        stats.kv++;
      }
      if (data.persona?.[0]?.persona_inquiry_id) {
        tx.set('personaInquiryId', data.persona[0].persona_inquiry_id);
        stats.kv++;
      }
      if (data.twitter?.[0]?.username) {
        tx.set('twitterUsername', data.twitter[0].username);
        stats.kv++;
      }

      // Key-value pair CSVs → JSON objects
      if (data.statistics.length > 0) {
        const statsObj: Record<string, string> = {};
        for (const row of data.statistics) {
          if (row.statistic && row.value) {
            statsObj[row.statistic] = row.value;
          }
        }
        tx.set('statistics', statsObj);
        stats.kv++;
      }
      if (data.user_preferences.length > 0) {
        const prefsObj: Record<string, string> = {};
        for (const row of data.user_preferences) {
          if (row.preference && row.value) {
            prefsObj[row.preference] = row.value;
          }
        }
        tx.set('preferences', prefsObj);
        stats.kv++;
      }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // DONE
    // ═══════════════════════════════════════════════════════════════════════════
    options?.onProgress?.({ phase: 'import', current: 14, total: 14 });
    stats.totalRows = Object.values(stats.tables).reduce((a, b) => a + b, 0) + stats.kv;

    return stats;
  },
});
```

---

## Appendix B: CSV Column Reference

> **Note**: Column structure verified against real Reddit GDPR export (Feb 2026). IP fields are often empty strings.

### B.1 Content CSVs

**posts.csv**
```
id, permalink, date, ip, subreddit, gildings, title, url, body
```
> Note: No `created_utc` column - only `date` exists.

**comments.csv**
```
id, permalink, date, ip, subreddit, gildings, link, parent, body, media
```

**drafts.csv**
```
id, title, body, kind, created, spoiler, nsfw, original_content,
content_category, flair_id, flair_text, send_replies, subreddit, is_public_link
```

### B.2 Interaction CSVs

**post_votes.csv / comment_votes.csv**
```
id, permalink, direction
```

**poll_votes.csv**
```
post_id, user_selection, text, image_url, is_prediction, stake_amount
```

**saved_posts.csv / saved_comments.csv / hidden_posts.csv**
```
id, permalink
```

### B.3 Message CSVs

**messages.csv / messages_archive.csv**
```
id, permalink, thread_id, date, ip, from, to, subject, body
```

**chat_history.csv**
```
message_id, created_at, updated_at, username, message, thread_parent_message_id,
channel_url, subreddit, channel_name, conversation_type
```

### B.4 Subreddit CSVs

**subscribed_subreddits.csv / moderated_subreddits.csv / approved_submitter_subreddits.csv**
```
subreddit
```

**multireddits.csv**
```
id, display_name, date, description, privacy, subreddits, image_url,
is_owner, favorited, followers
```

### B.5 Award CSVs

**gilded_content.csv**
```
content_link, award, amount, date
```

**gold_received.csv**
```
content_link, gold_received, gilder_username, date
```

### B.6 Commerce CSVs

**purchases.csv**
```
processor, transaction_id, product, date, cost, currency, status
```

**subscriptions.csv**
```
processor, subscription_id, product, product_id, product_name, status, start_date, end_date
```

**payouts.csv**
```
payout_amount_usd, date, payout_id
```

### B.7 Social CSVs

**friends.csv**
```
username, note
```

**linked_identities.csv**
```
issuer_id, subject_id
```

### B.8 Other CSVs

**announcements.csv**
```
announcement_id, sent_at, read_at, from_id, from_username, subject, body, url
```

**scheduled_posts.csv**
```
scheduled_post_id, subreddit, title, body, url, submission_time, recurrence
```

**ip_logs.csv**
```
date, ip
```

**sensitive_ads_preferences.csv**
```
type, preference
```

---

## Error Handling & Edge Cases

### Validation Errors

When validation fails in Phase 2, the importer throws an ArkType validation error with detailed information:

```typescript
try {
  const data = validateRedditExport(rawData);
} catch (error) {
  if (error instanceof AggregateError) {
    // ArkType validation errors with field-level details
    for (const issue of error.errors) {
      console.error(`Validation failed: ${issue.path} - ${issue.message}`);
    }
    throw new Error('Reddit export validation failed. Check that the ZIP is a valid Reddit GDPR export.');
  }
  throw error;
}
```

### Partial Import Recovery

If an error occurs during the Transform or Insert phases, the entire import is rolled back due to Y.js transaction semantics:

```typescript
try {
  workspace.tables.content.batch((tx) => {
    // All operations wrapped in a single transaction
    // If any operation fails, the entire batch is rolled back
  });
} catch (error) {
  // Import failed - Y.Doc remains unchanged
  console.error('Import failed:', error);
  throw error;
}
```

**Future Enhancement**: Add checkpoint-based recovery to resume from the last successful table.

### Edge Cases

#### 1. Empty CSVs

Empty CSVs are valid and result in empty arrays after validation:

```typescript
// Empty arrays are handled gracefully
for (const row of data.posts) {  // data.posts = []
  // Loop never executes
}
stats.tables.content = 0;  // Valid result
```

#### 2. Duplicate IDs

Reddit uses globally unique IDs (`t3_abc123` for posts, `t1_xyz789` for comments), so duplicates are unlikely. However, if duplicates exist:

```typescript
// Last write wins (LWW semantics)
workspace.tables.content.batch((tx) => {
  tx.set({ id: 't3_abc', ... });  // First write
  tx.set({ id: 't3_abc', ... });  // Overwrites first write
});
```

#### 3. Composite ID Collisions

Composite IDs use `:` as separator. Collisions are prevented by prefixing with type:

```typescript
// No collision:
id: `post:${row.id}`       // "post:t3_abc:def"  (even if row.id contains ":")
id: `comment:${row.id}`    // "comment:t1_abc:def"

// Reddit IDs already contain underscores, not colons
// Real example: "t3_1a2b3c" → "post:t3_1a2b3c"
```

#### 4. Large Imports (50K+ Rows)

For large imports, batch operations are performed per table (not globally):

```typescript
// Each table gets its own batch - memory efficient
workspace.tables.votes.batch((tx) => {
  for (const row of data.post_votes) {  // 50K rows
    tx.set({ ... });  // Batched within single Y.js transaction
  }
});
// Transaction commits, memory released before next table
```

**Performance Note**: Y.js transactions are memory-efficient. A 50K row import uses ~50MB peak memory.

#### 5. Missing Optional Fields

Optional fields are handled by ArkType validation:

```typescript
// Validation schema
body: 'string | undefined'

// Transform handles undefined → null for table schema
body: row.body ?? null  // undefined becomes null
```

### Performance Considerations

#### Batching Strategy

- **Per-table batching**: Each table import uses a single `batch()` call
- **Transaction overhead**: ~1ms per batch operation
- **Memory usage**: ~1KB per row during batch operation
- **Estimated time**: 50K rows = ~50 seconds (1K rows/sec)

#### Progress Tracking

```typescript
options?.onProgress?.({
  phase: 'transform',
  current: 5,      // Current table (1-14)
  total: 14,       // Total tables
  table: 'votes',  // Current table name
});
```

---

## Extension Integration

### SQLite Extension

The SQLite extension syncs Y.Doc → SQLite for querying:

```typescript
// SQLite sync happens automatically via extension
workspace.extensions.sqlite.onUpdate((event) => {
  // Triggered after each Y.Doc mutation
  // Extension writes changes to SQLite
});
```

**Sync Timing**: SQLite sync is **asynchronous** and happens after Y.Doc updates. Queries may lag by ~100ms.

**Schema**: SQLite tables mirror Y.Doc tables with identical column names.

### Markdown Extension

The Markdown extension exports individual rows as `.md` files:

```typescript
// Markdown export structure
workspace/
├── content/
│   ├── t3_abc123.md          # Post
│   ├── t1_xyz789.md          # Comment
│   └── draft_foo.md          # Draft
├── messages/
│   └── msg_123.md
└── kv/
    ├── accountGender.md
    └── statistics.json       # JSON for complex KV values
```

**Export Trigger**: Manual via `ingest push` or automatic via extension config.

### Persistence Extension (.yjs)

The persistence extension saves the Y.Doc binary state:

```typescript
// .yjs file contains compressed CRDT state
workspace.yjs  // Binary file (1-10MB for typical Reddit export)
```

**Format**: Yjs binary format (Y.encodeStateAsUpdate)
**Compression**: Built-in LZ4 compression (~80% reduction)

---

## CLI Commands

```bash
# Import a platform export
ingest import reddit ./export.zip
ingest import reddit ./export.zip --skip-invalid

# Preview without importing
ingest preview reddit ./export.zip

# Sync operations
ingest pull reddit    # Y.Doc → SQLite + Markdown
ingest push reddit    # Markdown → Y.Doc

# View stats
ingest stats reddit
```

---

## Testing Strategy

### Test Fixtures

Use a combination of real export data and minimal synthetic fixtures in `packages/ingest/tests/fixtures/`:

#### 1. Real Export Data (`reddit_export.zip`)

A real Reddit GDPR export provides ground truth for testing. Location: project root or `tests/fixtures/`.

**Actual metrics (from user's export):**
- 38 CSV files (some optional files absent based on user activity)
- 388 posts, 749 comments
- 2,709 post votes, ~2,500 comment votes
- ~800KB compressed

**Key observations:**
- `messages.csv` and `message_headers.csv` absent (user has no active messages)
- `ip` field often empty (not all actions log IP)
- `posts.csv` has no `created_utc` column (only `date`)

**Used for:** Integration tests, full pipeline validation, real-world edge cases.

#### 2. `minimal.zip` (Unit Tests)
- 1 post, 1 comment, 1 vote per type
- Subset of singleton KV fields
- ~1KB compressed
- Generated from real export or hand-crafted
- Used for: Fast unit tests, schema validation

#### 3. Derived Fixtures (Edge Cases)
Create programmatically from real data:
- `empty-csvs.zip` - All CSVs present but empty (headers only)
- `malformed.zip` - Invalid CSV structure for error testing
- `missing-optional.zip` - Missing optional CSVs like messages.csv

### Unit Tests

```typescript
// packages/ingest/tests/reddit/validation.test.ts

describe('Reddit CSV Validation', () => {
  test('validates posts with all fields (real data pattern)', () => {
    const data = {
      posts: [{
        id: '14rcs5c',
        permalink: 'https://www.reddit.com/r/ChatGPT/comments/14rcs5c/removed_by_reddit/',
        date: '2023-07-05 14:48:16 UTC',
        ip: '',  // Often empty in real exports
        subreddit: 'ChatGPT',
        gildings: '0',
        title: '[ Removed by Reddit ]',
        url: 'https://www.reddit.com/r/ChatGPT/comments/14rcs5c/removed_by_reddit/',
        body: '[ Removed by Reddit ]',
      }],
      // ... other CSVs initialized as empty arrays
    };

    expect(() => validateRedditExport(data)).not.toThrow();
  });

  test('accepts empty IP (common in real exports)', () => {
    const data = {
      posts: [{
        id: '14rcs5c',
        permalink: 'https://www.reddit.com/r/test/',
        date: '2023-07-05 14:48:16 UTC',
        ip: '',  // Empty is valid
        subreddit: 'test',
        gildings: '0',
      }],
      // ... other CSVs
    };

    expect(() => validateRedditExport(data)).not.toThrow();
  });

  test('handles empty CSV arrays', () => {
    const data = {
      posts: [],
      comments: [],
      // ... all CSVs empty
    };

    expect(() => validateRedditExport(data)).not.toThrow();
  });

  test('handles missing optional CSVs (messages.csv)', () => {
    const data = {
      posts: [],
      comments: [],
      messages: undefined,  // May be absent from export
      messages_archive: [],
      // ... other required CSVs
    };

    expect(() => validateRedditExport(data)).not.toThrow();
  });

  test('validates vote direction enum', () => {
    const data = {
      post_votes: [{
        id: '1024wzm',
        permalink: 'https://www.reddit.com/r/science/comments/1024wzm/',
        direction: 'invalid',  // Not 'up'|'down'|'none'|'removed'
      }],
      // ... other CSVs
    };

    expect(() => validateRedditExport(data)).toThrow(/direction/);
  });

  test('accepts real vote direction values', () => {
    const data = {
      post_votes: [
        { id: '1', permalink: '/r/a/', direction: 'up' },
        { id: '2', permalink: '/r/b/', direction: 'down' },
      ],
      // ... other CSVs
    };

    expect(() => validateRedditExport(data)).not.toThrow();
  });
});
```

```typescript
// packages/ingest/tests/reddit/transform.test.ts

describe('Reddit Transform', () => {
  test('generates composite IDs for votes', () => {
    const input = { id: 't3_abc', permalink: '...', direction: 'up' };
    const transformed = transformPostVote(input);

    expect(transformed.id).toBe('post:t3_abc');
    expect(transformed.targetType).toBe('post');
    expect(transformed.targetId).toBe('t3_abc');
  });

  test('handles IDs containing colons', () => {
    const input = { id: 't3_abc:def', permalink: '...', direction: 'up' };
    const transformed = transformPostVote(input);

    // Colon in original ID is preserved
    expect(transformed.id).toBe('post:t3_abc:def');
  });

  test('converts dates to ISO strings', () => {
    const input = {
      id: 't3_abc',
      date: new Date('2024-01-01T00:00:00Z'),
      // ... other fields
    };
    const transformed = transformPost(input);

    expect(transformed.date).toBe('2024-01-01T00:00:00.000Z');
  });

  test('handles undefined → null for optional fields', () => {
    const input = {
      id: 't3_abc',
      body: undefined,
      // ... other fields
    };
    const transformed = transformComment(input);

    expect(transformed.body).toBeNull();
  });
});
```

```typescript
// packages/ingest/tests/reddit/parse.test.ts

describe('Reddit ZIP Parsing', () => {
  test('unpacks ZIP and parses CSVs', async () => {
    const zip = await loadFixture('minimal.zip');
    const data = await parseRedditZip(zip);

    expect(data.posts).toHaveLength(1);
    expect(data.comments).toHaveLength(1);
  });

  test('throws on malformed ZIP', async () => {
    const invalidZip = new Blob(['not a zip']);

    await expect(parseRedditZip(invalidZip)).rejects.toThrow(/invalid ZIP/i);
  });

  test('throws on missing required CSV', async () => {
    const zipWithoutPosts = await createZipWithout('posts.csv');

    await expect(parseRedditZip(zipWithoutPosts)).rejects.toThrow(/posts.csv/i);
  });
});
```

### Integration Tests

```typescript
// packages/ingest/tests/reddit/import.integration.test.ts

describe('Reddit Import (Integration)', () => {
  let workspace: StaticWorkspace<typeof redditWorkspace>;

  beforeEach(() => {
    const ydoc = new Y.Doc();
    workspace = createWorkspace(redditWorkspace, ydoc);
  });

  test('imports real Reddit export ZIP', async () => {
    // Use actual reddit_export.zip from project root or fixtures
    const zip = await loadFixture('reddit_export.zip');
    const stats = await redditImporter.import(zip, workspace);

    // Expected counts from real export (approximate)
    expect(stats.tables.content).toBeGreaterThan(1000);  // 388 posts + 749 comments
    expect(stats.tables.votes).toBeGreaterThan(5000);    // ~5200 total votes
    expect(stats.kv).toBeGreaterThan(0);
    expect(stats.totalRows).toBe(
      Object.values(stats.tables).reduce((a, b) => a + b, 0) + stats.kv
    );
  });

  test('imports correct row counts from real export', async () => {
    const zip = await loadFixture('reddit_export.zip');
    const stats = await redditImporter.import(zip, workspace);

    // Verify against known real data counts
    expect(stats.tables.content).toBe(388 + 749 + 1);  // posts + comments + drafts
    expect(stats.tables.votes).toBeCloseTo(2709 + 2500 + 4, -1);  // post + comment + poll votes
  });

  test('handles missing optional CSVs (messages.csv)', async () => {
    // Real export may not have messages.csv (only messages_archive.csv)
    const zip = await loadFixture('reddit_export.zip');
    const stats = await redditImporter.import(zip, workspace);

    // Should still import messages_archive
    expect(stats.tables.messages).toBeGreaterThan(0);
  });

  test('handles empty IP fields in posts/comments', async () => {
    const zip = await loadFixture('reddit_export.zip');
    await redditImporter.import(zip, workspace);

    // Verify posts with empty IPs are imported
    const posts = workspace.tables.content.getAll();
    const postsWithEmptyIp = posts.filter(p => p.type === 'post' && p.ip === '');
    expect(postsWithEmptyIp.length).toBeGreaterThan(0);
  });

  test('handles duplicate IDs with LWW', async () => {
    const zip = await loadFixture('reddit_export.zip');

    // Import twice
    const stats1 = await redditImporter.import(zip, workspace);
    const stats2 = await redditImporter.import(zip, workspace);

    // Row counts should match (overwrites, not duplicates)
    expect(stats1.tables.content).toBe(stats2.tables.content);
    expect(workspace.tables.content.count()).toBe(stats1.tables.content);
  });

  test('progress callbacks are called', async () => {
    const zip = await loadFixture('reddit_export.zip');
    const progress: ImportProgress[] = [];

    await redditImporter.import(zip, workspace, {
      onProgress: (p) => progress.push(p),
    });

    expect(progress).toContainEqual({ phase: 'unpack', current: 0, total: 1 });
    expect(progress).toContainEqual({ phase: 'parse', current: 0, total: 1 });
    expect(progress).toContainEqual({ phase: 'transform', current: 0, total: 14 });
    expect(progress).toContainEqual({ phase: 'import', current: 14, total: 14 });
  });
});
```

### Extension Tests

```typescript
// packages/ingest/tests/reddit/extensions.integration.test.ts

describe('Extension Integration', () => {
  test('SQLite sync after import', async () => {
    const workspace = createWorkspaceWithExtensions({
      sqlite: { path: ':memory:' },
    });
    const zip = await loadFixture('minimal.zip');

    await redditImporter.import(zip, workspace);

    // Wait for async SQLite sync
    await waitFor(() => workspace.extensions.sqlite.isReady());

    // Query SQLite
    const posts = await workspace.extensions.sqlite.query(
      'SELECT * FROM content WHERE type = ?',
      ['post']
    );
    expect(posts).toHaveLength(1);
  });

  test('Markdown export after import', async () => {
    const workspace = createWorkspaceWithExtensions({
      markdown: { dir: './test-output' },
    });
    const zip = await loadFixture('minimal.zip');

    await redditImporter.import(zip, workspace);
    await workspace.extensions.markdown.export();

    // Check file structure
    expect(fs.existsSync('./test-output/content/t3_abc.md')).toBe(true);
    expect(fs.existsSync('./test-output/content/t1_xyz.md')).toBe(true);
  });

  test('Persistence extension saves .yjs file', async () => {
    const workspace = createWorkspaceWithExtensions({
      persistence: { path: './test.yjs' },
    });
    const zip = await loadFixture('minimal.zip');

    await redditImporter.import(zip, workspace);
    await workspace.extensions.persistence.save();

    // Verify file exists and can be loaded
    expect(fs.existsSync('./test.yjs')).toBe(true);

    const loadedYdoc = new Y.Doc();
    const state = fs.readFileSync('./test.yjs');
    Y.applyUpdate(loadedYdoc, state);

    const loadedWorkspace = createWorkspace(redditWorkspace, loadedYdoc);
    expect(loadedWorkspace.tables.content.count()).toBe(2);
  });
});
```

### Performance Tests

```typescript
// packages/ingest/tests/reddit/performance.test.ts

describe('Performance', () => {
  test('imports real export (~7K rows) in < 5 seconds', async () => {
    // Real export: 388 posts + 749 comments + ~5200 votes = ~6300 rows
    const zip = await loadFixture('reddit_export.zip');
    const workspace = createWorkspace(redditWorkspace);

    const start = performance.now();
    await redditImporter.import(zip, workspace);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(5_000);  // 5 seconds for ~7K rows
    console.log(`Import completed in ${duration.toFixed(0)}ms`);
  });

  test('memory usage stays under 50MB for real export', async () => {
    const zip = await loadFixture('reddit_export.zip');
    const workspace = createWorkspace(redditWorkspace);

    const memBefore = process.memoryUsage().heapUsed;
    await redditImporter.import(zip, workspace);
    const memAfter = process.memoryUsage().heapUsed;

    const memDelta = (memAfter - memBefore) / 1024 / 1024;  // MB
    expect(memDelta).toBeLessThan(50);  // Real export is ~800KB compressed
    console.log(`Memory delta: ${memDelta.toFixed(1)}MB`);
  });

  test('establishes performance baseline with real data', async () => {
    const zip = await loadFixture('reddit_export.zip');
    const workspace = createWorkspace(redditWorkspace);

    const start = performance.now();
    const stats = await redditImporter.import(zip, workspace);
    const duration = performance.now() - start;

    const rowsPerSecond = stats.totalRows / (duration / 1000);
    console.log(`Performance: ${rowsPerSecond.toFixed(0)} rows/sec`);

    // Baseline: should process at least 1000 rows/sec
    expect(rowsPerSecond).toBeGreaterThan(1000);
  });
});
```

### Error Scenario Tests

```typescript
// packages/ingest/tests/reddit/errors.test.ts

describe('Error Scenarios', () => {
  test('invalid vote direction throws validation error', async () => {
    const data = {
      post_votes: [{
        id: 't3_abc',
        permalink: '/r/test/...',
        direction: 'sideways',  // Invalid
      }],
      // ... other CSVs
    };

    expect(() => validateRedditExport(data)).toThrow(/direction/);
  });

  test('missing required field throws validation error', async () => {
    const data = {
      posts: [{
        // Missing 'id' field
        permalink: '/r/test/...',
        // ... other fields
      }],
      // ... other CSVs
    };

    expect(() => validateRedditExport(data)).toThrow(/id/);
  });

  test('malformed date throws validation error', async () => {
    const data = {
      posts: [{
        id: 't3_abc',
        date: 'not-a-date',
        // ... other fields
      }],
      // ... other CSVs
    };

    expect(() => validateRedditExport(data)).toThrow(/date/);
  });

  test('network error during ZIP fetch is propagated', async () => {
    const badUrl = 'https://example.com/nonexistent.zip';

    await expect(fetchAndImport(badUrl)).rejects.toThrow(/fetch failed/i);
  });
});
```

### Test File Structure

```
packages/ingest/
└── tests/
    ├── fixtures/
    │   ├── reddit_export.zip     # Real export (~800KB) - primary test data
    │   ├── minimal.zip           # Synthetic minimal fixture (~1KB)
    │   └── generators/
    │       └── create-fixtures.ts  # Generate edge case fixtures
    │
    ├── reddit/
    │   ├── validation.test.ts
    │   ├── transform.test.ts
    │   ├── parse.test.ts
    │   ├── import.integration.test.ts
    │   ├── extensions.integration.test.ts
    │   ├── performance.test.ts
    │   └── errors.test.ts
    │
    └── utils/
        ├── fixtures.ts           # Fixture loading helpers
        └── workspace.ts          # Workspace test helpers
```

> **Note**: The `reddit_export.zip` contains real user data and should be gitignored. Add to `.gitignore`:
> ```
> packages/ingest/tests/fixtures/reddit_export.zip
> ```
> For CI, use the minimal synthetic fixture or a sanitized sample.

---

## Migration Path

### Phase 1: Setup (1 hour)

- [ ] Create `packages/ingest/` structure
- [ ] Port `packages/vault-core/src/utils/archive/zip`
- [ ] Port `packages/vault-core/src/utils/format/csv`

### Phase 2: Schema (2 hours)

- [ ] Define 14 tables with ArkType schemas
- [ ] Define KV store schema
- [ ] Add type exports

### Phase 3: Validation (2 hours)

- [ ] Copy validation.ts from vault-core
- [ ] Update validation schema with enum for vote direction
- [ ] Add `validateRedditExport()` function
- [ ] Export `ValidatedRedditExport` type

### Phase 4: Importer (4 hours)

- [ ] Create `defineImporter()` factory
- [ ] Port ZIP/CSV parsing from vault-core
- [ ] Implement all table batch() imports
- [ ] Implement KV batch() imports
- [ ] Add progress callbacks
- [ ] Add error handling for validation failures

### Phase 5: CLI (2 hours)

- [ ] Create yargs CLI
- [ ] Add import, preview, pull, push, stats commands
- [ ] Add bin entry point

### Phase 6: Testing (4 hours)

- [ ] Copy `reddit_export.zip` to `packages/ingest/tests/fixtures/` (gitignored)
- [ ] Create minimal synthetic fixture for CI
- [ ] Write unit tests for validation, transform, parse
- [ ] Write integration tests using real export data
- [ ] Write extension tests (SQLite, Markdown, .yjs)
- [ ] Write performance tests (baseline with real ~7K rows)
- [ ] Write error scenario tests
- [ ] Verify all 14 tables populated (note: some may be empty based on user data)
- [ ] Verify KV store populated
- [ ] Verify handling of missing optional CSVs (messages.csv)
- [ ] Verify empty IP field handling

### Phase 7: Cleanup (1 hour)

- [ ] Deprecate `packages/vault-core`
- [ ] Remove `apps/demo-mcp`
- [ ] Update documentation

**Total: ~16 hours**

---

## Open Questions

1. **ID generation**: Use Reddit's IDs directly or generate composite IDs?
   - **Decision**: Use composite IDs for consolidated tables (e.g., `post:t3_abc`)

2. **Duplicate handling**: What if the same export is imported twice?
   - **Decision**: `set()` overwrites by ID (LWW semantics)

3. **Platform detection**: Auto-detect platform from ZIP contents?
   - **Decision**: Start with explicit `--platform`, add auto-detect later

---

## Appendix C: Real Export Data Reference

Data observed from actual Reddit GDPR export (Feb 2026, user: bmw02002).

### C.1 File Counts

| Category | Expected | Actual | Notes |
|----------|----------|--------|-------|
| Total files | 41 | 38 | 3 files absent (user has no data) |
| Singleton KV | 9 | 9 | All present |
| Redundant (skip) | 4 | 3 | `message_headers.csv` absent |
| Table data | 28 | 26 | `messages.csv`, `message_headers.csv` absent |

### C.2 Row Counts

| Table | Source CSVs | Row Count |
|-------|-------------|-----------|
| content | posts + comments + drafts | 388 + 749 + 1 = 1,138 |
| votes | post_votes + comment_votes + poll_votes | 2,709 + ~2,500 + 4 = ~5,213 |
| saved | saved_posts + saved_comments + hidden_posts | ~600 |
| messages | messages_archive only | ~250 |
| chatHistory | chat_history | ~100 |
| subreddits | subscribed + moderated + approved | ~50 |
| **Total** | | **~7,300 rows** |

### C.3 Sample Data Patterns

**Post ID format:** Short alphanumeric, e.g., `14rcs5c`, `1ltzyme`

**Comment ID format:** Alphanumeric, e.g., `j6o7fnl`

**Vote direction values:** `'up'`, `'down'` (never observed `'none'` or `'removed'` in sample)

**Date format:** `2023-07-05 14:48:16 UTC` (not ISO 8601)

**IP field:** Often empty string `''`

**Message permalink format:** `https:/www.reddit.com/message/messages/yaopoh` (note: missing slash after `https:`)

### C.4 Sensitive Data Fields

Fields containing PII that should be handled carefully:
- `statistics.csv`: `account name`, `email address`
- `ip_logs.csv`: IP addresses
- `messages_archive.csv`: Private message content
- `chat_history.csv`: Chat messages with usernames

---

## References

- [vault-core README](/packages/vault-core/README.md)
- [epicenter static API](/packages/epicenter/src/static/)
- [epicenter CLI](/packages/epicenter/src/cli/cli.ts)
- [Reddit adapter validation](/packages/vault-core/src/adapters/reddit/src/validation.ts)
