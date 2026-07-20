<script lang="ts" module>
	import type { CalendarDateString } from '@epicenter/field';
	import type { IanaTimeZone } from './iana-time-zone.js';

	export type CalendarDateChoice = {
		label: string;
		date: CalendarDateString;
	};

	/**
	 * Natural-language picker for a calendar day. Parses phrases like "tomorrow"
	 * or "next friday" and commits a `CalendarDateString`: no time, no offset,
	 * no zone. A calendar day is zoneless by nature, so the component renders no
	 * timezone UI and shows date-only suggestions; the `timeZone` prop only
	 * decides which day a relative phrase lands on for the viewer.
	 *
	 * This is the date-only sibling of {@link NaturalLanguageZonedDateTimeInput}.
	 * Use that one when the wall time and originating zone are the durable fact.
	 */
	export type NaturalLanguageCalendarDateInputProps = {
		/**
		 * IANA zone used to resolve relative phrases ("tomorrow", "next week") to
		 * a calendar day for the viewer. Defaults to the runtime's resolved zone.
		 * Nothing about the zone is stored.
		 */
		timeZone?: IanaTimeZone;
		placeholder?: string;
		onChoice?: (choice: CalendarDateChoice) => void;
	};

	const DEFAULT_SUGGESTION_PHRASES = [
		{ label: 'Today', text: 'today' },
		{ label: 'Tomorrow', text: 'tomorrow' },
		{ label: 'This weekend', text: 'saturday' },
		{ label: 'Next week', text: 'next monday' },
	] as const;
</script>

<script lang="ts">
	import * as Command from '../command/index.js';
	import { currentIanaTimeZone } from './iana-time-zone.js';
	import { parseInZone } from './parse.js';

	let {
		placeholder = 'E.g. "tomorrow" or "next friday"',
		timeZone = currentIanaTimeZone(),
		onChoice,
	}: NaturalLanguageCalendarDateInputProps = $props();

	let value = $state('');

	/**
	 * Project a parsed instant to the calendar day it falls on *in `timeZone`*,
	 * so "tomorrow at 11pm" is still tomorrow's date for the viewer rather than
	 * sliding into the next UTC day.
	 */
	function toCalendarDay(date: Date): CalendarDateString {
		return new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).format(date) as CalendarDateString;
	}

	const suggestions = $derived.by(() => {
		const referenceNow = new Date();
		const phrases = value.trim()
			? [{ label: value, text: value }]
			: DEFAULT_SUGGESTION_PHRASES;

		// Multiple times-of-day for one phrase collapse to a single day, so a
		// date-only picker never lists the same date twice.
		const seen = new Set<string>();
		const days: CalendarDateChoice[] = [];
		for (const phrase of phrases) {
			for (const parsed of parseInZone({
				text: phrase.text,
				referenceNow,
				timeZone,
			})) {
				const date = toCalendarDay(parsed.date);
				if (seen.has(date)) continue;
				seen.add(date);
				days.push({
					label: value.trim() ? parsed.label : phrase.label,
					date,
				});
			}
		}
		return days;
	});

	/**
	 * Render a stored `CalendarDateString` date-only, building the `Date` from
	 * its own Y-M-D parts so no zone can shift the displayed day.
	 */
	function formatDay(date: CalendarDateString): string {
		const [year, month, day] = date.split('-').map(Number);
		return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
			new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1),
		);
	}
</script>

<Command.Root shouldFilter={false} class="h-fit">
	<Command.Input {placeholder} bind:value />
	<Command.List>
		<Command.Empty>No date found.</Command.Empty>
		{#if suggestions.length > 0}
			<Command.Group>
				{#each suggestions as suggestion (suggestion.date)}
					<Command.Item
						onSelect={() => {
							onChoice?.(suggestion);
						}}
					>
						<div class="flex w-full place-items-center justify-between gap-2">
							<span> {suggestion.label} </span>
							<span class="text-muted-foreground">
								{formatDay(suggestion.date)}
							</span>
						</div>
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}
	</Command.List>
</Command.Root>
