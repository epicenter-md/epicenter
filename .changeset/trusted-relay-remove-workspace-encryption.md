---
'@epicenter/identity': minor
---

Drop the keyring from `AuthState` now that the sync relay is trusted.

The `signed-in` and `reauth-required` variants no longer carry a `keyring`
field; `ownerId` still picks the local storage partition.

Migration is a one-off manual step. There is no deployed encrypted data, so
clear local devices once.
