# Singular Table Names Because Better Auth Got There First

We use singular table names in Drizzle. Not because it's the right convention. I actually prefer plural, and most style guides agree with me. But because Better Auth got there first.

When you run `auth:generate`, Better Auth writes your schema for you. The tables it creates are `user`, `session`, `account`, `verification`, and `jwks`. Those names are fixed. Better Auth owns them, and you don't get a vote.

```typescript
export const user = pgTable('user', { ... });
export const session = pgTable('session', { ... });
export const account = pgTable('account', { ... });
export const verification = pgTable('verification', { ... });
export const jwks = pgTable('jwks', { ... });
```

So the question isn't "singular or plural?" It's "do you want a mixed schema?"

Mixed is worse than either consistent choice. Imagine opening the schema file and seeing `user` next to `challenges`, or `session` next to `participants`. Every new table forces a decision: match the convention you prefer, or match what's already there. You'll get it wrong half the time, and six months later nobody remembers why some tables are singular and some aren't.

The cascade is straightforward. Better Auth generates singular tables. Those tables exist. Every new table you add has to live next to them. So new tables are singular too: `challenge`, `participant`, `ledger_entry`. Not because singular is correct, but because consistency is.

Drizzle makes this slightly more annoying than it sounds. With most ORMs you name the table once. With Drizzle you name it twice. The TypeScript export and the SQL table string are separate:

```typescript
export const challenge = pgTable('challenge', { ... });
//           ^^^^^^^^^              ^^^^^^^^^
//           TS export              SQL name
```

Switching conventions means renaming in two places per table. And if you have relations, those reference the export name. A rename ripples. The cost of inconsistency compounds.

Better Auth plugins make this worse. The OAuth plugin adds `oauth_client`, `oauth_access_token`, `oauth_refresh_token`, `oauth_consent`, and `device_code`. The organization plugin adds `organization`, `member`, `invitation`. Every plugin you add drops more singular tables into your schema. The convention isn't just set by the core tables. It's reinforced every time you install a plugin.

Rails uses plural. TypeORM uses plural. Drizzle's own docs use `users`, `posts`, `comments`. Prisma models are singular. SQLAlchemy is whatever you want. The community consensus is "pick one and be consistent," which is the right answer. We just didn't get to pick.

If you're starting a project without Better Auth, use plural. If you're using Better Auth, use singular and don't fight it.
