---
"wellcrafted": patch
---

Adds default generics for `defineMutation`. Because we set a default generic `void` for `TVariables`, we can  call `mutation.mutate()` instead of having to always put in `mutation.mutate({})`.
