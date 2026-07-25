# Backlog

## Remove Local Mail's headless continuous watcher

- Desired result: Remove `local-mail sync --watch` so the open desktop app is
  the only continuous synchronization owner while one-shot `sync` remains
  available for explicit freshness.
- Grounding:
  [ADR-0116](docs/adr/0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md)
  says Local Mail does not update automatically while the app is closed.
- Revisit when: Local Mail next changes its CLI or synchronization lifecycle.

## Make Sign in with Apple a supported product path

- Desired result: Expose and support Sign in with Apple wherever Epicenter
  presents its supported account sign-in and linking providers.
- Grounding: The server already contains optional Apple provider configuration,
  but the current product UI has no corresponding entry point.
- Revisit when: Epicenter next changes authentication providers or account
  linking.

## Add human-reviewed LLM cleanup to Local Mail

- Desired result: Let an LLM propose precise groups of low-value Gmail messages,
  require review of the exact messages, and move only the approved batch to
  recoverable Gmail Trash.
- Grounding: Local Mail already treats Gmail as the source of truth and requires
  human-meaningful state to round-trip through Gmail.
- Revisit when: Local Mail next expands its triage or agent-assisted workflows.

## Add Outlook as a standalone Local Mail provider

- Desired result: Support one Outlook account and an Outlook-only inbox through
  Microsoft Graph before introducing a combined Gmail and Outlook inbox.
- Grounding: Keep provider identity explicit and provider storage and actions
  separate so a combined inbox remains possible without forcing either provider
  into the other's model.
- Revisit when: Local Mail next expands beyond Gmail.
