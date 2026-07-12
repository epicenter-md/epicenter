# Reddit GDPR export ingestion

Parses a Reddit data export ZIP into plain transformed arrays and account
metadata. The importer does not create, own, or write to a workspace or
database. A consuming application decides whether and where to persist the
returned data.

## Architecture

```text
parse.ts        -> ZIP to raw CSV records
csv-schemas.ts  -> validation and transformation
index.ts        -> transformed table arrays, metadata, and import stats
```

Large CSV files that Reddit splits into numbered parts, such as
`post_votes_1.csv` and `post_votes_2.csv`, are concatenated. UTF-8 BOMs are
stripped from every decoded file.

## Result

`importRedditExport` returns:

- `tables`: one transformed array for each of the 24 supported row-oriented
  CSV files
- `metadata`: account `statistics` and `preferences` records, or `null` when
  their source CSV is absent
- `stats`: per-table counts, metadata count, total imported rows, skipped row
  count, and validation errors

Malformed rows do not abort the import. Each one is omitted from its table and
reported with its table name, zero-based source row index, and validation
message.

## Supported table CSVs

The importer transforms posts, comments, drafts, post and comment votes, poll
votes, saved posts and comments, hidden posts, messages and archived messages,
chat history, subscribed, moderated, and approved-submitter subreddits,
multireddits, gilded content, gold received, purchases, subscriptions, payouts,
friends, announcements, and scheduled posts.

The `statistics.csv` and `user_preferences.csv` files become metadata records.
Every supported file is optional.

Header-only variants are excluded because their full counterparts contain the
same rows. Integrity files, login IP history, advertising preferences, and
opaque linked-identity, payment, and verification identifiers are also
excluded. The importer intentionally does not retain the `ip` column found in
some content CSVs.
