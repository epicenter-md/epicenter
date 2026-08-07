---
name: taste-review
description: Ask Claude Code to make a taste-driven call on something ambiguous — UI polish, prose phrasing, naming, formatting. Use when you'd otherwise guess.
---

You hit something fuzzy and need a judgment call. Shell out to the `claude` CLI to get one back, then apply it.

Run from the repo root so `claude` can read files by relative path:

Run outside the sandbox when required, requesting reusable approval for the
`claude -p` prefix. On macOS, use the optional long-lived subscription OAuth
token from Keychain when present. Otherwise, fall back to that machine's normal
Claude authentication.

```bash
prompt="$(cat <<'EOF'
<your question, stated plainly>

Files to consider: <paths, if any>

Weigh a few options, give your recommendation, and share others as alternatives considered.
Length is up to you — a design call may warrant several paragraphs;
a naming call may not. Match the depth to the decision.
EOF
)"

if [[ "$(uname)" == "Darwin" ]] &&
  oauth_token="$(
    security find-generic-password \
      -a "$USER" \
      -s "Claude Code skill OAuth" \
      -w 2>/dev/null
  )"; then
  CLAUDE_CODE_OAUTH_TOKEN="$oauth_token" claude -p "$prompt"
else
  claude -p "$prompt"
fi
```
