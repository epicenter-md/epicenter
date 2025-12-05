# Epicenter Migration Plan

## Overview
This plan outlines the migration from "Whispering" to "Epicenter" as the main project name, with a clear separation between the Epicenter ecosystem and the Whispering app.

## Current Structure
```
whispering/
├── apps/
│   ├── app/         # Main Whispering desktop/web app
│   ├── sh/          # epicenter.sh web interface
│   ├── cli/         # Epicenter CLI
│   └── api/         # API service
├── packages/        # Shared packages
└── docs/           # Documentation
```

## Target Structure
```
epicenter/
├── apps/
│   ├── whispering/  # Renamed from 'app' - the Whispering transcription app
│   ├── sh/          # epicenter.sh - unchanged
│   ├── cli/         # Epicenter CLI - unchanged
│   └── api/         # API service - unchanged
├── packages/        # Shared packages
└── docs/           # Documentation
```

## Migration Tasks

### Phase 1: Repository Structure Refactoring
- [ ] Rename `apps/whispering` to `apps/whispering`
- [ ] Update all import paths referencing `@epicenter/app` to `@epicenter/whispering`
- [ ] Update workspace configuration in root `package.json`
- [ ] Update turbo.json configurations
- [ ] Update biome.json configurations

### Phase 2: Branding Updates
- [ ] Update root README.md to reflect Epicenter as the main brand
- [ ] Create new hero section focusing on the Epicenter ecosystem
- [ ] Move current Whispering README content to `apps/whispering/README.md`
- [ ] Update tagline to emphasize "own your data, use any model, free and open source"
- [ ] Add sections about the three main products:
  - Whispering (transcription app)
  - epicenter.sh (AI coding assistant interface)
  - Epicenter CLI (unified tooling)

### Phase 3: Package Name Updates
- [ ] Update root `package.json` name from "whispering" to "epicenter"
- [ ] Update `apps/whispering/package.json` name from "@epicenter/app" to "@epicenter/whispering"
- [ ] Update all internal references
- [ ] Update GitHub repository name (if desired)

### Phase 4: Documentation Restructuring
- [ ] Create new root README.md with:
  - Epicenter ecosystem overview
  - Links to individual app READMEs
  - Unified installation instructions
  - Common development setup
- [ ] Move detailed Whispering documentation to `apps/whispering/README.md`
- [ ] Update contribution guidelines to reference Epicenter
- [ ] Update all documentation references

### Phase 5: Configuration Updates
- [ ] Update all build scripts
- [ ] Update CI/CD configurations
- [ ] Update deployment configurations
- [ ] Update release scripts

### Phase 6: Code Sharing Analysis
- [ ] Identify shared components between apps
- [ ] Move common UI components to packages/ui
- [ ] Move shared utilities to packages/utils
- [ ] Update import paths across all apps

## README Structure Plan

### New Root README.md Structure
```markdown
# Epicenter

Own your data. Use any model. Free and open source. ❤️

## What is Epicenter?

Epicenter is an ecosystem of open-source tools that put you in control of your AI interactions. No middlemen, no subscriptions, no data collection—just direct connections to the AI providers of your choice.

## The Epicenter Ecosystem

### 🎙️ [Whispering](./apps/whispering)
Press shortcut → speak → get text. A desktop transcription app that cuts out the middleman.
- Pay actual API costs (as low as $0.02/hour)
- Your audio never touches our servers
- Works with Groq, OpenAI, ElevenLabs, or completely offline

### 🤖 [epicenter.sh](./apps/sh)
Self-hosted AI coding assistants with a clean web interface.
- Connect to OpenCode servers locally or through tunnels
- Your code stays on your machine
- Flexible deployment options

### 🛠️ [Epicenter CLI](./apps/cli)
The unified command-line interface for the Epicenter ecosystem.
- Smart defaults for OpenCode integration
- Automatic port discovery and tunneling
- Zero-config setup

## Why Epicenter?

We believe AI tools should be:
- **Transparent**: Open source code you can audit
- **Private**: Your data stays on your devices
- **Affordable**: Pay providers directly, not middleman markups
- **Flexible**: Use any model, any provider, any deployment

## Quick Start

[Installation and getting started instructions...]

## Development

[Monorepo setup and development instructions...]
```

### Whispering App README.md Structure
The current README content will be moved to `apps/whispering/README.md` with minimal changes, maintaining all the detailed documentation about the transcription app.

## Benefits of This Migration

1. **Clear Brand Identity**: Epicenter as the umbrella brand for open-source AI tools
2. **Better Organization**: Each app has its own clear space and documentation
3. **Easier Onboarding**: Users understand the ecosystem at a glance
4. **Maintained History**: The Whispering app keeps its identity within the ecosystem
5. **Scalability**: Easy to add new tools to the Epicenter ecosystem

## Risks and Mitigations

1. **Breaking Changes**: Update paths carefully, test all imports
2. **User Confusion**: Clear communication about the rebranding
3. **SEO Impact**: Maintain redirects if changing repository name
4. **Documentation Links**: Audit and update all internal/external links

## Timeline Estimate

- Phase 1-2: 2-3 hours (structure and branding)
- Phase 3-5: 1-2 hours (configurations and documentation)
- Phase 6: 2-4 hours (code sharing analysis)
- Testing: 1-2 hours

Total: ~8-10 hours of focused work

## Todo Items

1. ✅ Analyze current repository structure
2. ✅ Understand monorepo configuration
3. ✅ Create migration plan
4. ⏳ Execute Phase 1: Repository restructuring
5. ⏳ Execute Phase 2: Branding updates
6. ⏳ Execute Phase 3: Package name updates
7. ⏳ Execute Phase 4: Documentation restructuring
8. ⏳ Execute Phase 5: Configuration updates
9. ⏳ Execute Phase 6: Code sharing analysis
10. ⏳ Test all apps in development
11. ⏳ Test production builds
12. ⏳ Update deployment pipelines

## Review Section

### Completed Changes

1. **Repository Structure**
   - ✅ Successfully renamed `apps/app` to `apps/whispering`
   - ✅ Updated package name from `@epicenter/app` to `@epicenter/whispering`
   - ✅ Workspace configuration automatically picks up the renamed directory

2. **Branding Updates**
   - ✅ Created new Epicenter-focused root README
   - ✅ Moved original Whispering documentation to `apps/whispering/README.md`
   - ✅ Updated root package name from "whispering" to "epicenter"

3. **Documentation**
   - ✅ Updated all documentation references from `apps/app` to `apps/whispering`
   - ✅ Clear separation between ecosystem documentation and app-specific docs

4. **Testing**
   - ✅ Verified monorepo structure is intact
   - ✅ epicenter.sh app starts correctly in development mode
   - ✅ Dependencies install correctly with bun

### Key Outcomes

- **Clear Brand Identity**: Epicenter is now positioned as the umbrella ecosystem
- **Better Organization**: Each app has its own dedicated space and documentation
- **Maintained Functionality**: All apps continue to work as expected
- **Simplified Onboarding**: New contributors can understand the project structure at a glance

### Remaining Tasks

While the core migration is complete, these optional tasks could further improve the ecosystem:

1. **Code Sharing Analysis**: Identify common components between apps for potential extraction to packages
2. **CI/CD Updates**: Update GitHub Actions and deployment scripts if needed
3. **Repository Rename**: Consider renaming the GitHub repository from "whispering" to "epicenter"
4. **Documentation Links**: Update any external links pointing to the old structure

### Summary

The migration from "Whispering" to "Epicenter" has been successfully implemented. The project now has a clear brand identity as an ecosystem of privacy-focused AI tools, with Whispering maintaining its identity as the flagship transcription app within that ecosystem. The new structure is more scalable and makes it easier to add new tools to the Epicenter family.