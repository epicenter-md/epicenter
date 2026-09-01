// The shapes the components render, derived from Local Mail's own modules
// rather than hand-copied. A change to a read model surfaces here, and then in
// the components, as a type error rather than a silent drift.

import type { mail } from './mail';

export type MailboxStatus = Awaited<ReturnType<typeof mail.status>>;

export type MailLabel = Awaited<
	ReturnType<typeof mail.labels>
>['labels'][number];

export type MessageSummary = Awaited<
	ReturnType<typeof mail.messages>
>['messages'][number];

export type MessageDetail = NonNullable<Awaited<ReturnType<typeof mail.message>>>;

export type { ConnectedAccount } from './mail';
