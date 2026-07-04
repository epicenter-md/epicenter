---
'@epicenter/workspace': minor
'@epicenter/filesystem': patch
---

Give the fractional-index ordering math its own home. `computeMidpoint` and `generateInitialOrders` are generic ordering helpers, but they lived inside the timeline folder and were the only thing anyone imported from the `@epicenter/workspace/document/attach-timeline` subpath. They move to `src/document/fractional-index.ts` and ship from a new `@epicenter/workspace/document/fractional-index` subpath. The `@epicenter/workspace/document/attach-timeline` subpath is removed (its sole consumer used it only for these two helpers; `attachTimeline` itself is exported from the package root). `@epicenter/filesystem` is repointed to the new subpath.
