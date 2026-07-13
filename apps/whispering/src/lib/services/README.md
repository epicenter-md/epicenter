# Services

Services are narrow I/O contracts used by Whispering's build-selected runtime
roots. They do not choose a host at runtime.

```text
#runtime
|-- browser.ts
|   |-- browser recorder
|   |-- IndexedDB artifact store
|   |-- browser clipboard and downloads
|   `-- remote transcription engine
|
`-- epicenter.ts
    |-- native recorder
    |-- filesystem artifact store
    |-- native cursor delivery
    `-- local transcription engine
```

Shared product code consumes the complete `environment` exported by `#runtime`.
Epicenter-only adapters use `#desktop` or generated commands. New code must not
introduce a generic platform service locator, nullable native capability bag, or
runtime host check.

Keep service contracts focused on I/O and return typed `Result` values where an
operation can fail. Settings and product policy belong to the runtime or caller,
not inside a service implementation.
