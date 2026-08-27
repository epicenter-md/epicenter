<script lang="ts">
	import { HOSTED_MODELS, providerLabel } from '@epicenter/constants/hosted-catalog';
	import * as Table from '@epicenter/ui/table';

	// The catalog is a compile-time constant, so the table never pends or errors.
	// Per-model cost is token-based and resolved Cloud-side per request, so there
	// is no fixed per-call credit to show here; the tier label (Fast/Best) is the
	// at-a-glance cost signal. A live per-request credit estimate is a
	// Cloud-sourced follow-up (spec 20260826T120000-inference-credit-billing).
	const rows = HOSTED_MODELS.map((entry) => ({
		model: entry.id,
		provider: entry.provider,
		tier: entry.label,
	}));
</script>

<Table.Root>
	<Table.Header>
		<Table.Row>
			<Table.Head>Model</Table.Head>
			<Table.Head>Provider</Table.Head>
			<Table.Head class="text-right">Tier</Table.Head>
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each rows as row (row.model)}
			<Table.Row>
				<Table.Cell class="font-mono text-xs">{row.model}</Table.Cell>
				<Table.Cell class="text-muted-foreground text-xs">
					{providerLabel(row.provider)}
				</Table.Cell>
				<Table.Cell class="text-right tabular-nums">{row.tier}</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
