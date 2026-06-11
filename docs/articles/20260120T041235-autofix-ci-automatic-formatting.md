# Why I Don't Block PRs on Formatting

I don't believe in failing CI because of formatting issues. Instead, I use autofix.ci to commit formatting fixes directly to the PR branch.

## Why

Formatting is mechanical. Given the same input, the formatter always produces the same output. There's no judgment, no ambiguity. If the machine knows exactly how the code should look, why make a human fix it manually?

When someone submits working code with inconsistent indentation, blocking their PR feels punitive. They wrote the feature. It works. Now they have to context switch back, run the formatter, push again, wait for CI. All for something a machine could fix in milliseconds.

## How autofix.ci Works

The workflow runs the formatter. If anything changed, autofix.ci pushes a commit to the PR branch. No failure, no notification, no roundtrip. The contributor sees their PR updated with a formatting commit, and that's it.

It works securely with fork PRs too. Autofix.ci handles permissions without requiring elevated access or personal tokens.

## Who Uses This

TanStack Query, Prettier, Biome, Vue, Nuxt, tRPC, Bun, and many other major open source projects. Prettier recommends autofix.ci in their official CI documentation.

## Setup

1. Install the GitHub App: https://github.com/apps/autofix-ci
2. Create a workflow that runs your formatter and calls `autofix-ci/action@v1`
3. Remove your `format:check` step

That's it.

## References

- https://autofix.ci
- https://prettier.io/docs/ci
