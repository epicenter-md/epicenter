# Contributing to Epicenter

Welcome! We're excited you're interested in contributing to Epicenter. This guide will help you get up and running quickly.

## Prerequisites

- **Bun**: We use Bun as our JavaScript runtime and package manager
  - Install from [bun.sh](https://bun.sh) if you don't have it
  - The repo requires Bun 1.2.19 or newer (automatically enforced)

## Getting Started

Epicenter is a monorepo containing multiple applications. The main application ready for contributions is **Whispering** (located in `apps/whispering`).

### Quick Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/epicenter-md/epicenter.git
   cd epicenter
   ```

2. **Install dependencies**
   ```bash
   bun install
   ```
   
   > **Note**: If you see a version warning, run `bun upgrade` to update to the required version. The repository uses Bun 1.2.19 to ensure consistency across all contributors.
   
   > **Note**: Desktop app development requires external tools not installed by the command above. Install these manually.
   > (For example: [Rust](https://www.rust-lang.org/tools/install) and [CMake](https://cmake.org/download/))

3. **Navigate to the Whispering app**
   ```bash
   cd apps/whispering
   ```

4. **Start development**
   ```bash
   # Run both web and desktop mode
   bun dev
   
   # Or run just the web version
   bun dev:web
   ```

That's it! You're ready to start contributing.

## Project Structure

This is a monorepo with the following structure:

```
epicenter/
├── apps/
│   ├── whispering/     # Main transcription app (ready for contributions)
│   ├── sh/             # Local assistant (in development)
│   └── ...             # Other apps in various stages
├── packages/
│   ├── db/             # Shared database schema for our hosted services
│   ├── ui/             # Shared UI components
│   └── ...
└── ...
```

### Where to Contribute

Currently, **Whispering** (`apps/whispering`) is the most mature application and the best place to start contributing. Check the [Whispering README](apps/whispering/README.md) for specific details about that application.

## Development Workflow

1. **Create a branch** for your feature or fix
   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Make your changes** following our coding standards (see below)

3. **Test your changes** thoroughly
   ```bash
   # Run tests if available
   bun test
   ```

4. **Commit using conventional commits**
   ```bash
   git commit -m "feat(whispering): add new feature"
   ```

5. **Push and create a pull request**
   ```bash
   git push origin feat/your-feature-name
   ```

## Coding Standards

### TypeScript
- Use `type` instead of `interface`
- Prefer absolute imports over relative imports
- Use object method shorthand syntax when appropriate

### Svelte
- We use Svelte 5 with the latest runes syntax
- Follow shadcn-svelte patterns for UI components
- Use Tailwind CSS for styling

### Commits
We follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat`: New features
- `fix`: Bug fixes
- `docs`: Documentation changes
- `refactor`: Code refactoring
- `test`: Test additions or changes
- `chore`: Maintenance tasks

Examples:
- `feat(whispering): add model selection for OpenAI providers`
- `fix(sound): resolve audio import paths`
- `docs: update contribution guidelines`

## Troubleshooting

### Version Mismatch Warning
If you see a warning about Bun version mismatch:
```bash
# Update to the latest Bun version
bun upgrade

# Or install the specific version mentioned in the warning
curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.19"
```

### Installation Issues
- Make sure you're in the repository root when running `bun install`
- Clear the cache if you encounter issues: `bun pm cache rm`
- On Windows, you may need to run your terminal as Administrator

## Getting Help

- **Discord**: Join our community at [go.epicenter.so/discord](https://go.epicenter.so/discord) and DM me to get started contributing
- **Issues**: Check existing issues or create a new one
- **Documentation**: Each app has its own README with specific details

## Philosophy

We believe in:
- **Local-first**: Your data stays on your machine
- **Open source**: Everything is transparent and auditable
- **User ownership**: You own your data and choose your models
- **Simplicity**: Every change should be as simple as possible

## What We're Looking For

- Bug fixes and improvements to existing features
- Performance optimizations
- Documentation improvements
- New features that align with our local-first philosophy
- UI/UX enhancements

## Questions?

Feel free to:
- Open an issue for discussion
- Join our Discord and DM me directly to get started

Thank you for contributing to Epicenter! We're building something special together.
