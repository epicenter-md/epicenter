declare const ianaTimeZoneBrand: unique symbol;

/** IANA time zone name accepted by the host Intl implementation. */
export type IanaTimeZone = string & {
	readonly [ianaTimeZoneBrand]: true;
};

/** Resolve the host's current IANA time zone. */
export function currentIanaTimeZone(): IanaTimeZone {
	return Intl.DateTimeFormat().resolvedOptions().timeZone as IanaTimeZone;
}
