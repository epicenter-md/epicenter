<script lang="ts">
	import * as Accordion from '@epicenter/ui/accordion';
	import { Alert, AlertDescription, AlertTitle } from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Separator } from '@epicenter/ui/separator';
	import {
		ArrowDown,
		ArrowLeft,
		ArrowRight,
		Database,
		FileText,
		GitBranch,
		HardDrive,
		Info,
	} from '@lucide/svelte';
	import { codeToHtml } from 'shiki';

	const techBadges = [
		'Yjs CRDTs',
		'In-Browser SQLite',
		'IndexedDB',
		'Svelte 5',
		'CodeMirror 6',
	] as const;

	const capabilities = [
		{
			icon: GitBranch,
			title: 'CRDT Storage',
			description:
				'Every file row lives in a Yjs Y.Map. Create, rename, delete, move\u2014all conflict-free. No server needed.',
		},
		{
			icon: FileText,
			title: 'Per-File Documents',
			description:
				'Each file gets its own Y.Doc with a Y.Text instance. CodeMirror binds directly to it via y-codemirror.next. Collaborative editing is built in.',
		},
		{
			icon: HardDrive,
			title: 'IndexedDB Persistence',
			description:
				'The workspace persists all Y.Docs to IndexedDB automatically. Close the tab, reopen\u2014your notes are there.',
		},
		{
			icon: Database,
			title: 'In-Browser SQLite',
			description:
				'A WASM-based SQLite database indexes the file tree for O(1) parent\u2192children lookups. The tree view and command palette read from this index.',
		},
	] as const;

	const roadmap = [
		'Markdown preview',
		'Full-text search',
		'Internal links between notes',
		'Plugin system for custom extensions',
	] as const;

	const workspaceCode = `import { createSqliteIndex, createYjsFileSystem, filesTable } from '@epicenter/filesystem';
import { defineWorkspace, createWorkspace } from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';

const definition = defineWorkspace({
  id: 'opensidian',
  tables: { files: filesTable },
});

export const workspace = createWorkspace(definition)
  .withExtension('persistence', indexeddbPersistence)
  .withWorkspaceExtension('sqliteIndex', createSqliteIndex());

export const fs = createYjsFileSystem(workspace.tables.files, workspace.documents.files.content);`;

	const codeAnnotations = [
		{
			id: 'define-workspace',
			line: 'defineWorkspace({ id, tables })',
			explanation:
				'Declares the workspace schema—a unique ID and typed tables. Each table becomes a Y.Map of rows inside a shared Y.Doc.',
		},
		{
			id: 'create-workspace',
			line: 'createWorkspace(definition)',
			explanation:
				'Instantiates the workspace from the definition. Returns a builder—chain .withExtension() to add persistence, sync, or other capabilities.',
		},
		{
			id: 'persistence',
			line: ".withExtension('persistence', indexeddbPersistence)",
			explanation:
				"Attaches IndexedDB persistence\u2014every Y.Doc update is written to the browser's local storage automatically.",
		},
		{
			id: 'sqlite-index',
			line: ".withWorkspaceExtension('sqliteIndex', createSqliteIndex())",
			explanation:
				'Spins up a WASM SQLite database that mirrors the Yjs table into SQL rows for fast tree queries.',
		},
		{
			id: 'filesystem',
			line: 'createYjsFileSystem(workspace.tables.files, workspace.documents.files.content)',
			explanation:
				'Wraps the raw table and document APIs into a familiar filesystem interface\u2014writeFile, mkdir, rm, mv.',
		},
	] as const;

	const footerLinks = [
		{
			href: 'https://github.com/EpicenterHQ/epicenter/tree/main/apps/opensidian',
			label: 'GitHub (Opensidian)',
		},
		{
			href: 'https://github.com/EpicenterHQ/epicenter',
			label: 'Epicenter Project',
		},
		{
			href: 'https://go.epicenter.so/discord',
			label: 'Discord',
		},
	] as const;

	let highlightedCode = $state('');

	$effect(() => {
		codeToHtml(workspaceCode, {
			lang: 'typescript',
			themes: { light: 'github-light', dark: 'github-dark' },
			defaultColor: false,
		}).then((html) => {
			highlightedCode = html;
		});
	});
</script>

<style>
	:global(html.dark .shiki),
	:global(html.dark .shiki span) {
		color: var(--shiki-dark) !important;
		background-color: var(--shiki-dark-bg) !important;
	}

	:global(.shiki) {
		background-color: transparent !important;
	}
</style>

<div class="mx-auto max-w-3xl px-6 py-12">
	<!-- Back navigation -->
	<Button
		variant="ghost"
		size="sm"
		href="/"
		class="text-muted-foreground mb-8 gap-1.5"
	>
		<ArrowLeft aria-hidden="true" class="size-3.5" />
		Back to editor
	</Button>

	<!-- Header -->
	<header>
		<h1 class="text-4xl font-extrabold tracking-tight">Opensidian</h1>
		<p class="text-muted-foreground mt-2 text-lg">
			Open-source, local-first notes&mdash;built on CRDTs
		</p>
		<div class="mt-4 flex flex-wrap gap-2">
			{#each techBadges as label}
				<Badge variant="secondary">{label}</Badge>
			{/each}
		</div>
	</header>

	<Separator class="my-10" />

	<!-- How it works -->
	<section>
		<h2 class="text-2xl font-semibold tracking-tight">How it works</h2>
		<p class="text-muted-foreground mt-3 leading-relaxed">
			Every note is a Yjs document. Edits are CRDT operations&mdash;they merge
			automatically and never conflict. The Y.Doc persists to IndexedDB so your
			data survives page refreshes. A SQLite index (running in-browser via WASM)
			materializes the file tree for fast parent/child lookups.
		</p>

		<!-- Visual data flow -->
		<div class="mt-6 flex flex-col items-center gap-3">
			<!-- Row 1: Edits → Y.Doc → IndexedDB -->
			<div class="flex items-center gap-3">
				<Badge variant="outline" class="px-3 py-1.5">Your edits</Badge>
				<ArrowRight
					aria-hidden="true"
					class="text-muted-foreground size-4 shrink-0"
				/>
				<Badge variant="default" class="px-3 py-1.5">Y.Doc (CRDT)</Badge>
				<ArrowRight
					aria-hidden="true"
					class="text-muted-foreground size-4 shrink-0"
				/>
				<Badge variant="outline" class="px-3 py-1.5">IndexedDB</Badge>
			</div>

			<ArrowDown aria-hidden="true" class="text-muted-foreground size-4" />

			<!-- Row 2: SQLite Index -->
			<Badge variant="secondary" class="px-3 py-1.5"
				>SQLite Index (fast queries)</Badge
			>

			<ArrowDown aria-hidden="true" class="text-muted-foreground size-4" />

			<!-- Row 3: File Tree + Search -->
			<div class="flex items-center gap-3">
				<Badge variant="outline" class="px-3 py-1.5">File Tree</Badge>
				<Badge variant="outline" class="px-3 py-1.5">Search</Badge>
			</div>
		</div>
	</section>

	<Separator class="my-10" />

	<!-- The entire data layer -->
	<section>
		<h2 class="text-2xl font-semibold tracking-tight">The entire data layer</h2>
		<p class="text-muted-foreground mt-3 leading-relaxed">
			The data layer is a handful of files under
			<code class="bg-muted rounded px-1.5 py-0.5 font-mono text-sm"
				>src/lib/workspace/</code
			>
			and
			<code class="bg-muted rounded px-1.5 py-0.5 font-mono text-sm"
				>src/lib/client.ts</code
			>:
		</p>
		<Card.Root class="mt-6 overflow-hidden">
			<!-- File header bar -->
			<Card.Header class="border-b px-4 py-2">
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-2">
						<FileText
							aria-hidden="true"
							class="text-muted-foreground size-3.5"
						/>
						<span class="font-mono text-sm">client.ts</span>
					</div>
					<div class="flex items-center gap-2">
						<Badge variant="secondary" class="text-xs">TypeScript</Badge>
						<CopyButton
							text={workspaceCode}
							variant="ghost"
							size="icon-xs"
							class="opacity-60 hover:opacity-100"
						/>
					</div>
				</div>
			</Card.Header>
			<Card.Content class="p-0">
				<div class="overflow-x-auto p-4 text-sm leading-relaxed">
					{#if highlightedCode}
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html highlightedCode}
					{:else}
						<pre class="font-mono"><code>{workspaceCode}</code></pre>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>
		<p class="text-muted-foreground mt-4 leading-relaxed">
			That's it. The workspace API handles the hard parts:
		</p>
		<Accordion.Root type="multiple" class="mt-4">
			{#each codeAnnotations as annotation}
				<Accordion.Item value={annotation.id}>
					<Accordion.Trigger class="py-2 text-sm">
						<code class="bg-muted rounded px-1.5 py-0.5 font-mono text-xs"
							>{annotation.line}</code
						>
					</Accordion.Trigger>
					<Accordion.Content>
						<p class="text-muted-foreground pb-2 text-sm leading-relaxed">
							{annotation.explanation}
						</p>
					</Accordion.Content>
				</Accordion.Item>
			{/each}
		</Accordion.Root>
	</section>

	<Separator class="my-10" />

	<!-- What the workspace API provides -->
	<section>
		<h2 class="text-2xl font-semibold tracking-tight">
			What the workspace API provides
		</h2>
		<div class="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
			{#each capabilities as capability}
				<Card.Root>
					<Card.Header>
						<div class="flex items-center gap-2">
							<capability.icon
								aria-hidden="true"
								class="text-muted-foreground size-4"
							/>
							<Card.Title class="text-base">{capability.title}</Card.Title>
						</div>
						<Card.Description class="leading-relaxed">
							{capability.description}
						</Card.Description>
					</Card.Header>
				</Card.Root>
			{/each}
		</div>
	</section>

	<Separator class="my-10" />

	<!-- What's next -->
	<section>
		<h2 class="text-2xl font-semibold tracking-tight">What's next</h2>
		<Alert class="mt-4">
			<Info aria-hidden="true" class="size-4" />
			<AlertTitle>Roadmap</AlertTitle>
			<AlertDescription>
				<ul class="mt-2 space-y-1.5 text-sm leading-relaxed">
					{#each roadmap as item}
						<li class="flex items-start gap-2">
							<span class="text-muted-foreground/50 select-none">&bull;</span>
							{item}
						</li>
					{/each}
				</ul>
			</AlertDescription>
		</Alert>
	</section>

	<Separator class="my-10" />

	<!-- Footer -->
	<footer class="flex flex-wrap gap-2">
		{#each footerLinks as link}
			<Button
				variant="ghost"
				size="sm"
				href={link.href}
				target="_blank"
				rel="noopener noreferrer"
				class="text-muted-foreground"
			>
				{link.label}
			</Button>
		{/each}
	</footer>
</div>
