/**
 * This application's one id, spent by everything that scopes something to it.
 *
 * The auth leaf keys its persisted grant with it, `createEpicenter` scopes the
 * SQLite files, the keychain, and the replica with it, and the data definition
 * declares it. Those were three literals in three files, which is three places
 * for one identity to drift; the value has an owner now and they import it.
 *
 * Reverse domain is the grammar, not a convention: `isAppId` in
 * `@epicenter/constants/app-id` requires two or more dot-separated lowercase
 * labels and refuses a bare one (ADR-0204).
 */
export const APP_ID = 'so.epicenter.vocab';
