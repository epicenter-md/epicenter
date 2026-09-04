/**
 * This application's one id, spent by everything that scopes something to it.
 *
 * The auth leaf keys its persisted grant with it, `createEpicenter` scopes the
 * SQLite files, the keychain, and the replica with it, and the data definition
 * declares it. Those were three literals in three files, which is three places
 * for one identity to drift; the value has an owner now and they import it.
 *
 * Reverse domain because every composed application here is spelled that way.
 * It is a convention rather than a grammar: `isAppId` admits a bare label too,
 * because an admitted folder's name is its id (ADR-0179).
 */
export const APP_ID = 'so.epicenter.whispering';
