# Opensidian Terminal Panel

**Date:** 2026-03-19
**Status:** Implemented
**Scope:** `apps/opensidian`, `packages/filesystem`

## Problem

Opensidian has a complete file management UI (tree, editor, tabs) but no way to run commands against the virtual filesystem. Users who want to batch-create files, search content, or manipulate their workspace with familiar Unix commands have to do everything through the GUI.

## Key Insight

The infrastructure already exists. `createYjsFileSystem` in `packages/filesystem` implements the `IFileSystem` interface from `just-bash`. The test suite proves the integration works: `echo`, `cat`, `grep`, `find`, `mkdir`, `rm`, `mv`, `cp`, `wc` all operate on the Yjs CRDT and trigger reactive updates. The only missing piece is a UI to type commands and see output.

## Approach: Simple REPL

A REPL-style terminal panel. Monospace input line at the bottom, scrollable output above. This matches `just-bash`'s batch execution model (`exec()` returns `{stdout, stderr, exitCode}`) without fighting a PTY abstraction.

**Why not ghostty-web/xterm.js?** Those are designed for streaming PTY connections. `just-bash` returns batch results. You'd have to manually buffer keystrokes, render fake prompts, and pipe output via `term.write()`. A simple REPL is honest to the execution model and ships faster. Can upgrade later if real shell access is added via Tauri.

## Design

### Layout

Nest a vertical `Resizable.PaneGroup` inside the existing right pane. The terminal panel lives below the editor and collapses to zero height when hidden.

```
┌──────────┬─────────────────────────────┐
│          │  TabBar                      │
│          │  PathBreadcrumb              │
│  File    │  ┌─────────────────────────┐ │
│  Tree    │  │                         │ │
│          │  │  ContentEditor          │ │
│          │  │                         │ │
│          │  ├─── drag handle ─────────┤ │
│          │  │ $ echo "hello" > hi.md  │ │
│          │  │ $ cat hi.md             │ │
│          │  │ hello                   │ │
│          │  │ $ █                     │ │
│          │  └─────────────────────────┘ │
└──────────┴─────────────────────────────┘
```

**Toggle:** `Ctrl+`` (backtick) shows/hides the terminal pane. When hidden, the editor pane takes 100% of the vertical space.

### AppShell Change

Current `AppShell.svelte` structure:

```svelte
<Resizable.PaneGroup direction="horizontal">
  <Resizable.Pane defaultSize={25}><!-- FileTree --></Resizable.Pane>
  <Resizable.Handle />
  <Resizable.Pane defaultSize={75}><ContentPanel /></Resizable.Pane>
</Resizable.PaneGroup>
```

New structure. Nest a vertical split inside the right pane:

```svelte
<Resizable.PaneGroup direction="horizontal" class="flex-1">
  <Resizable.Pane defaultSize={25} minSize={15} maxSize={50}>
    <ScrollArea class="h-full">
      <div class="p-2"><FileTree /></div>
    </ScrollArea>
  </Resizable.Pane>
  <Resizable.Handle withHandle />
  <Resizable.Pane defaultSize={75}>
    <Resizable.PaneGroup direction="vertical">
      <Resizable.Pane defaultSize={terminalOpen ? 70 : 100} minSize={30}>
        <ContentPanel />
      </Resizable.Pane>
      {#if terminalOpen}
        <Resizable.Handle withHandle />
        <Resizable.Pane defaultSize={30} minSize={10} maxSize={60}>
          <TerminalPanel />
        </Resizable.Pane>
      {/if}
    </Resizable.PaneGroup>
  </Resizable.Pane>
</Resizable.PaneGroup>
```

### Bash Instance

Single `Bash` instance per workspace, created alongside `fs` in `workspace.ts`:

```typescript
import { Bash, defineCommand } from 'just-bash';
import { fs } from './workspace';

export const bash = new Bash({ fs, cwd: '/' });
```

The `Bash` constructor accepts the existing `fs` directly. No adapter needed. The filesystem is shared across `exec()` calls, so files created in one command are visible in the next. Shell state (env vars, functions, cwd) resets between calls by default.

### Terminal State

New file: `src/lib/state/terminal-state.svelte.ts`

```typescript
type TerminalEntry =
  | { type: 'input'; command: string }
  | { type: 'output'; stdout: string; stderr: string; exitCode: number };

function createTerminalState() {
  let open = $state(false);
  let history = $state<TerminalEntry[]>([]);
  let commandHistory = $state<string[]>([]);
  let historyIndex = $state(-1);
  let running = $state(false);

  return {
    get open() { return open; },
    get history() { return history; },
    get running() { return running; },

    toggle() { open = !open; },
    show() { open = true; },
    hide() { open = false; },

    async exec(command: string) {
      if (!command.trim() || running) return;
      running = true;
      history = [...history, { type: 'input', command }];
      commandHistory = [...commandHistory, command];
      historyIndex = -1;
      try {
        const result = await bash.exec(command);
        history = [...history, {
          type: 'output',
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }];
      } catch (err) {
        history = [...history, {
          type: 'output',
          stdout: '',
          stderr: err instanceof Error ? err.message : 'Unknown error',
          exitCode: 1,
        }];
      } finally {
        running = false;
      }
    },

    // Arrow-up/down command recall
    previousCommand() { /* bump historyIndex, return commandHistory entry */ },
    nextCommand() { /* decrement historyIndex */ },

    clear() { history = []; },
  };
}

export const terminalState = createTerminalState();
```

### TerminalPanel Component

New file: `src/lib/components/terminal/TerminalPanel.svelte`

```svelte
<script lang="ts">
  import { ScrollArea } from '@epicenter/ui/scroll-area';
  import { terminalState } from '$lib/state/terminal-state.svelte';
  import TerminalOutput from './TerminalOutput.svelte';
  import TerminalInput from './TerminalInput.svelte';
</script>

<div class="flex h-full flex-col border-t bg-background font-mono text-sm">
  <div class="flex items-center justify-between border-b px-3 py-1">
    <span class="text-xs font-medium text-muted-foreground">Terminal</span>
    <button onclick={() => terminalState.hide()}
      class="text-xs text-muted-foreground hover:text-foreground">
      ✕
    </button>
  </div>
  <ScrollArea class="flex-1">
    <div class="p-3 space-y-1">
      {#each terminalState.history as entry}
        <TerminalOutput {entry} />
      {/each}
    </div>
  </ScrollArea>
  <TerminalInput />
</div>
```

### TerminalOutput Component

New file: `src/lib/components/terminal/TerminalOutput.svelte`

Renders a single history entry. Input lines show with `$` prompt. Output lines are plain text. Stdout in default color, stderr in red, non-zero exit codes shown as a badge.

```svelte
<script lang="ts">
  let { entry } = $props();
</script>

{#if entry.type === 'input'}
  <div class="text-muted-foreground">
    <span class="text-green-500">$</span> {entry.command}
  </div>
{:else}
  {#if entry.stdout}
    <pre class="whitespace-pre-wrap text-foreground">{entry.stdout}</pre>
  {/if}
  {#if entry.stderr}
    <pre class="whitespace-pre-wrap text-destructive">{entry.stderr}</pre>
  {/if}
  {#if entry.exitCode !== 0}
    <span class="text-xs text-destructive">exit {entry.exitCode}</span>
  {/if}
{/if}
```

### TerminalInput Component

New file: `src/lib/components/terminal/TerminalInput.svelte`

```svelte
<script lang="ts">
  import { terminalState } from '$lib/state/terminal-state.svelte';

  let value = $state('');
  let inputEl: HTMLInputElement | undefined = $state();

  async function handleSubmit() {
    const cmd = value;
    value = '';
    await terminalState.exec(cmd);
    // Auto-scroll handled by ScrollArea reactivity
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = terminalState.previousCommand();
      if (prev !== undefined) value = prev;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = terminalState.nextCommand();
      value = next ?? '';
    }
  }
</script>

<div class="flex items-center border-t px-3 py-2">
  <span class="mr-2 text-green-500">$</span>
  <input
    bind:this={inputEl}
    bind:value
    onkeydown={handleKeydown}
    disabled={terminalState.running}
    placeholder={terminalState.running ? 'Running...' : 'Type a command...'}
    class="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
    spellcheck="false"
    autocomplete="off"
  />
</div>
```

### Keyboard Shortcut

Add to `AppShell.svelte`:

```svelte
<svelte:window onkeydown={(e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '`') {
    e.preventDefault();
    terminalState.toggle();
    // Focus the input when opening
  }
}} />
```

### Custom Commands (Optional, Phase 2)

`just-bash` supports `defineCommand` for app-specific commands:

```typescript
const open = defineCommand('open', async (args, ctx) => {
  const path = args[0];
  if (!path) return { stdout: '', stderr: 'Usage: open <path>', exitCode: 1 };
  const id = fs.lookupId(path);
  if (!id) return { stdout: '', stderr: `No such file: ${path}`, exitCode: 1 };
  // Trigger fsState.selectFile(id) via event or store
  return { stdout: `Opened ${path}`, stderr: '', exitCode: 0 };
});

const search = defineCommand('search', async (args, ctx) => {
  // Trigger SQLite full-text search via ws.extensions.sqliteIndex
  // Return matching file paths
});

export const bash = new Bash({ fs, cwd: '/', customCommands: [open, search] });
```

These are nice-to-have. The core terminal works without them.

## What just-bash Provides (Browser-Compatible)

From the `just-bash` README, these commands work in the browser (which is Opensidian's runtime):

- **File ops:** `cat`, `cp`, `ls`, `mkdir`, `mv`, `rm`, `rmdir`, `touch`, `tree`, `stat`
- **Text processing:** `awk`, `grep`, `head`, `tail`, `sed`, `sort`, `uniq`, `wc`, `cut`, `diff`
- **Data processing:** `jq` (JSON), `yq` (YAML)
- **Navigation:** `cd`, `find`, `pwd`, `echo`, `env`
- **Shell features:** pipes, redirections, `&&`/`||`, variables, globs, if/for/while

**Not available in browser:** `python3`, `sqlite3`, `js-exec`, `OverlayFs`/`ReadWriteFs`

## Security

- **No real system access.** `just-bash` is a pure TypeScript emulator. No `child_process`, no `exec`, no real filesystem.
- **Sandboxed to Yjs.** The blast radius is bounded to the virtual CRDT document. Worst case: `rm -rf /` deletes all virtual files.
- **Built-in execution limits.** Infinite loop protection, max recursion depth, max command count. All configurable.
- **No network by default.** `curl` returns "command not found" unless explicitly enabled.

## Implementation Plan

- [x] Create `src/lib/state/terminal-state.svelte.ts`: terminal state singleton with history, exec, command recall
- [x] Create `src/lib/components/terminal/TerminalOutput.svelte`: renders input/output entries
- [x] Create `src/lib/components/terminal/TerminalInput.svelte`: input line with prompt, Enter to exec, arrow keys for history
- [x] Create `src/lib/components/terminal/TerminalPanel.svelte`: composes output + input with header and scroll area
- [x] Update `workspace.ts`: add `Bash` instance export
- [x] Update `AppShell.svelte`: nest vertical PaneGroup, wire terminal visibility, add `Ctrl+\`` shortcut
- [ ] Verify: `echo "test" > /new.md` creates a file visible in the file tree
- [ ] Verify: `cat` on an existing file shows its content
- [ ] Verify: `Ctrl+\`` toggles the panel, keyboard focus moves to input on open

## Out of Scope (Phase 2)

- Custom commands (`open`, `search`)
- ANSI color rendering
- Tab completion
- Multiple terminal instances
- ghostty-web/xterm.js upgrade
- Tauri shell plugin for real system commands
- Terminal persistence across page reloads

## Review

### Changes Made

**New files (4):**

1. **`src/lib/state/terminal-state.svelte.ts`**: Reactive terminal state singleton following the `fs-state.svelte.ts` factory pattern. Manages open/closed visibility, scrollable history (input + output entries), command recall via arrow keys, and `exec()` delegation to `bash.exec()`. Exported as `terminalState`.

2. **`src/lib/components/terminal/TerminalOutput.svelte`**: Renders a single history entry. Input lines display with a green `$` prompt. Output entries show stdout in default color, stderr in destructive red, and non-zero exit codes as a badge.

3. **`src/lib/components/terminal/TerminalInput.svelte`**: Monospace input line with `$` prompt. Enter submits, ArrowUp/ArrowDown cycle command history. Disables during execution with "Running..." placeholder. Exports a `focus()` method for programmatic focus.

4. **`src/lib/components/terminal/TerminalPanel.svelte`**: Composes TerminalOutput + TerminalInput with a header bar (title + close button) and ScrollArea. Auto-scrolls to bottom on new entries via `$effect`. Exports `focus()` for keyboard shortcut integration.

**Modified files (3):**

5. **`src/lib/workspace.ts`**: Added `Bash` import from `just-bash` and exported a singleton `bash` instance backed by the existing `fs`. No adapter needed: `createYjsFileSystem` already satisfies `IFileSystem`.

6. **`src/lib/components/AppShell.svelte`**: Nested a vertical `Resizable.PaneGroup` inside the right pane. Terminal panel conditionally renders below the editor when `terminalState.open` is true. Added `Ctrl+\`` / `Cmd+\`` keyboard shortcut via `<svelte:window onkeydown>`. Focus auto-moves to terminal input on open.

7. **`apps/opensidian/package.json`**: Added `just-bash: ^2.9.7` to devDependencies.

### Design Decisions

- **No `$effect` for focus**: Focus-on-open uses `requestAnimationFrame` in the keydown handler rather than a reactive effect, avoiding unnecessary effect registrations on every render.
- **ScrollArea wrapping**: The scroll container uses `bind:this` on an inner div rather than the ScrollArea itself, since ScrollArea is a component wrapper and the native scroll methods need a real DOM element.
- **Immutable history updates**: All history mutations use spread (`[...history, entry]`) to trigger Svelte 5 reactivity on the `$state` array, matching the pattern in `fs-state.svelte.ts`.
