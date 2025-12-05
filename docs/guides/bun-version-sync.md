# Syncing Bun Versions Across Local and CI

We had Bun version drift: `package.json` said 1.3.0, local had 1.3.1, and CI used `latest`. Not a crisis, but annoying when debugging CI failures that work locally.

## What We Had Before

The workflows were inconsistent:

```yaml
# Some workflows used an env variable
env:
  BUN_VERSION: 'latest'

- uses: oven-sh/setup-bun@v2
  with:
    bun-version: ${{ env.BUN_VERSION }}

# Others just hardcoded "latest"
- uses: oven-sh/setup-bun@v2
  with:
    bun-version: latest

# Only format.yml was doing it right
- uses: oven-sh/setup-bun@v2
  with:
    bun-version-file: "package.json"
```

Meanwhile `package.json` had `"packageManager": "bun@1.3.0"` which nobody was reading except one workflow.

## The Fix

Make `package.json` the single source of truth.

In `package.json`:
```json
"packageManager": "bun@1.3.3"
```

In every GitHub Actions workflow:
```yaml
- name: Setup Bun
  uses: oven-sh/setup-bun@v2
  with:
    bun-version-file: "package.json"
```

We updated these workflows:
- `deploy-cloudflare.yml` (3 places)
- `publish-tauri-releases.yml`
- `pr-preview-builds.yml`
- `preview-deployment.yml`
- `cleanup-preview.yml`

Now when you want to upgrade Bun, change one line in `package.json` and everything follows.

## Pro Tip

The `oven-sh/setup-bun` action reads the version from your `packageManager` field automatically. No need to hardcode versions in workflow files or maintain a separate `.bun-version` file.

This also works with `.tool-versions` if you're using asdf, but `package.json` is already there so why add another file.
