<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import * as Table from '@epicenter/ui/table';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createDataBrowser } from './data.svelte.ts';
	import { isDesktopHost } from './runtime.ts';

	/**
	 * Epicenter's own pane: the data raw (ADR-0209).
	 *
	 * Applications are the crafted views. This is where you go when something is
	 * wrong, or when you want to see across applications, and it should stay
	 * deliberately plain: a sidebar of namespaces, a statement, and rows.
	 *
	 * The sidebar is the mode selector rather than a filter. Picking a namespace
	 * is `selectLens`, which makes `SELECT * FROM notes` mean something; picking
	 * "Everything raw" is `clearLens`, which is the only view spanning
	 * applications and shows JSON and tombstones as they are.
	 *
	 * Desktop only, because ADR-0162 keeps inspection native for V1. The routes
	 * are same-origin and this gate is the product boundary that record already
	 * describes, not a sandbox.
	 */

	const { ready }: { ready: Promise<void> } = $props();

	const browser = createDataBrowser();
	// The bootstrap promise is fixed for this document lifetime.
	// svelte-ignore state_referenced_locally
	const loaded = isDesktopHost()
		? ready.then(async () => {
				await browser.load();
				await browser.run();
			})
		: null;
</script>

{#if loaded !== null}
	{#await loaded}
		<Loading class="h-full" label="Loading your data" />
	{:then}
		<div class="flex h-full min-h-0">
			<nav
				class="flex w-52 flex-none flex-col gap-0.5 overflow-y-auto border-e p-2"
				aria-label="Namespaces"
			>
				{#each browser.namespaces as entry (entry.namespace)}
					<!-- The name a Lens gives its namespace, over the namespace itself.
					     Both, because the friendly one is what you recognize and the
					     address is what you type into the statement beside it. A Lens
					     that declares no title shows the address alone. -->
					<Button
						variant={browser.selected === entry.namespace ? 'secondary' : 'ghost'}
						size="sm"
						class="h-auto flex-col items-start gap-0 py-1.5 text-xs"
						onclick={() => browser.select(entry.namespace)}
					>
						{#if entry.title}
							<span>{entry.title}</span>
							<span class="font-mono text-[0.6875rem] text-muted-foreground">
								{entry.namespace}
							</span>
						{:else}
							<span class="font-mono">{entry.namespace}</span>
						{/if}
					</Button>

					<!-- The tables of the selected namespace, because you cannot query a
					     table you have no way to name. Their columns are what `selectLens`
					     will produce, which is the same list the header shows once one
					     runs. -->
					{#if browser.selected === entry.namespace}
						{#each entry.tables as table (table.name)}
							<Button
								variant="ghost"
								size="sm"
								class="ms-3 justify-start font-mono text-xs text-muted-foreground"
								title={table.fields.join(', ')}
								onclick={() => browser.selectTable(table.name)}
							>
								{table.name}
							</Button>
						{/each}
					{/if}
				{/each}

				<!-- Everything raw sits below a gap rather than in the list: it is the
				     absence of an interpretation, not another one. -->
				<Button
					variant={browser.selected === undefined ? 'secondary' : 'ghost'}
					size="sm"
					class="mt-2 justify-start border-t pt-3 text-xs"
					onclick={() => browser.select(undefined)}
				>
					Everything raw
				</Button>
			</nav>

			<!-- `min-w-0` is load-bearing: a flex item defaults to `min-width: auto`,
			     so a result wider than the window would widen this column instead of
			     scrolling inside it, and carry the statement box and Run off-screen
			     with it. Bounded here, `Table.Root`'s own container scrolls. -->
			<div class="flex min-h-0 min-w-0 flex-1 flex-col">
				<form
					class="flex flex-none gap-2 border-b p-2"
					onsubmit={(event) => {
						event.preventDefault();
						void browser.run();
					}}
				>
					<Textarea
						bind:value={browser.sql}
						rows={2}
						spellcheck={false}
						aria-label="SQL"
						class="min-h-0 resize-y font-mono text-xs"
					/>
					<Button type="submit" size="sm" disabled={browser.running}>
						{browser.running ? 'Running' : 'Run'}
					</Button>
				</form>

				{#if browser.truncated && !browser.failure}
					<!-- Above the rows rather than after them. The rows below are correct
					     and complete up to the bound; there were simply more, and a
					     thousand of them put this sentence fifty screens down, which is
					     the same as not saying it. -->
					<p
						class="flex-none border-b px-3 py-1.5 text-xs text-muted-foreground"
					>
						Stopped at the result bound. Narrow the query to see the rest.
					</p>
				{/if}

				<!-- Vertical only: `Table.Root` ships its own horizontal scroll
				     container, so letting this one scroll sideways too would take the
				     header row away from its columns. -->
				<div class="min-h-0 min-w-0 flex-1 overflow-y-auto">
					{#if browser.failure}
						<Alert.Root variant="destructive" class="m-3 w-auto">
							<Alert.Title>That query did not run</Alert.Title>
							<Alert.Description class="font-mono text-xs">
								{browser.failure}
							</Alert.Description>
						</Alert.Root>
					{:else if browser.rows.length === 0}
						<Empty.Root class="h-full border-0">
							<Empty.Header>
								<Empty.Title>No rows</Empty.Title>
								<Empty.Description>
									The statement ran and matched nothing.
								</Empty.Description>
							</Empty.Header>
						</Empty.Root>
					{:else}
						<Table.Root class="text-xs">
							<Table.Header>
								<Table.Row>
									{#each browser.columns as column (column)}
										<Table.Head class="font-mono">{column}</Table.Head>
									{/each}
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each browser.rows as row, index (index)}
									<Table.Row>
										{#each browser.columns as column (column)}
											<Table.Cell
												class="max-w-80 truncate font-mono align-top"
												title={String(row[column] ?? '')}
											>
												{row[column] === null ? '—' : String(row[column])}
											</Table.Cell>
										{/each}
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</div>
			</div>
		</div>
	{:catch error}
		<Alert.Root variant="destructive" class="m-3 w-auto">
			<Alert.Title>Could not read your data</Alert.Title>
			<Alert.Description>
				{error instanceof Error ? error.message : String(error)}
			</Alert.Description>
		</Alert.Root>
	{/await}
{:else}
	<Empty.Root class="h-full border-0">
		<Empty.Header>
			<Empty.Title>Your data is on the desktop</Empty.Title>
			<Empty.Description>
				This Home is showing the session from a browser. The raw view reads the
				replica on the machine running Epicenter.
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{/if}
