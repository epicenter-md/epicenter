<script lang="ts" module>
	import type { DateTimeString } from '@epicenter/field';
	import type { IanaTimeZone } from './iana-time-zone.js';

	export type ZonedDateTimeChoice = {
		label: string;
		date: DateTimeString;
		dateZone: IanaTimeZone;
	};

	/**
	 * Natural-language picker for a zoned datetime. Parses phrases like
	 * "tomorrow at 5pm" and commits a wall time plus its originating zone
	 * (`{ date: DateTimeString, dateZone }`). The durable fact is *when, where*.
	 *
	 * This is the zoned sibling of {@link NaturalLanguageCalendarDateInput}. Use
	 * that one when only the calendar day matters and no time or zone is stored.
	 */
	export type NaturalLanguageZonedDateTimeInputProps = {
		/**
		 * Seed zone. The component owns the draft internally; later changes to
		 * this prop do not update the displayed zone.
		 */
		initialDateZone?: IanaTimeZone;
		placeholder?: string;
		onChoice: (choice: ZonedDateTimeChoice) => void;
	};

	const DEFAULT_SUGGESTION_PHRASES = [
		{ label: 'Today', text: 'today' },
		{ label: 'Tomorrow', text: 'tomorrow' },
		{ label: 'In 2 hours', text: 'in 2 hours' },
		{ label: 'Next week', text: 'next week' },
	] as const;
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import * as Command from '../command/index.js';
	import { TimezoneCombobox } from '../timezone-combobox/index.js';
	import { currentIanaTimeZone } from './iana-time-zone.js';
	import { parseInZone } from './parse.js';

	let {
		initialDateZone,
		placeholder = 'E.g. "tomorrow at 5pm" or "in 2 hours"',
		onChoice,
	}: NaturalLanguageZonedDateTimeInputProps = $props();

	let dateZone = $state<IanaTimeZone>(
		untrack(() => initialDateZone) ?? currentIanaTimeZone(),
	);
	let value = $state('');

	// Suggestions resolve in the chosen zone, so changing the combobox below
	// re-interprets a typed phrase like "5pm" against the new zone.
	const suggestions = $derived.by(() => {
		const referenceNow = new Date();
		if (value.trim()) {
			return parseInZone({ text: value, referenceNow, timeZone: dateZone });
		}
		return DEFAULT_SUGGESTION_PHRASES.flatMap((phrase) =>
			parseInZone({ text: phrase.text, referenceNow, timeZone: dateZone }).map(
				({ date }) => ({ label: phrase.label, date }),
			),
		);
	});

	const formatter = $derived(
		new Intl.DateTimeFormat(undefined, {
			timeZone: dateZone,
			dateStyle: 'medium',
			timeStyle: 'short',
		}),
	);
</script>

<div class="space-y-2">
	<Command.Root shouldFilter={false} class="h-fit">
		<Command.Input {placeholder} bind:value />
		<Command.List>
			<Command.Empty>No date found.</Command.Empty>
			{#if suggestions.length > 0}
				<Command.Group>
					{#each suggestions as suggestion (suggestion.date.toISOString())}
						<Command.Item
							onSelect={() => {
								onChoice({
									label: suggestion.label,
									date: suggestion.date.toISOString() as DateTimeString,
									dateZone,
								});
							}}
						>
							<div class="flex w-full place-items-center justify-between gap-2">
								<span> {suggestion.label} </span>
								<span class="text-muted-foreground">
									{formatter.format(suggestion.date)}
								</span>
							</div>
						</Command.Item>
					{/each}
				</Command.Group>
			{/if}
		</Command.List>
	</Command.Root>
	<TimezoneCombobox bind:value={dateZone} />
</div>
