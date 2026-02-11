# Vault Architecture Overview

## Discussion

After a long discussion, we settled on loose requirements for the vault architectures. There was extensive discussion over the user of nano-ids, document-based storage, and having multiple data ingest layers. 

### Key Requirements

After careful consideration, the following were established as key requirements. 

- **Portability**: Data needs to be serializable/deserializable at the filesystem level.
- **Transparency**: The user can easily inspect the data and its structure.
- **Synchronization**: Data should be syncronizable across devices using a reliable mechanism.

Some conclusions on the above:

#### Portability

Concrete requirements for portability are slightly vague for now. We verbally settled on a "push pull" model, wherein data can be externally reset or pushed to a remote source. See [synchronization](#synchronization) for more details.

Due to changing requirements, a composable strategy should be adopted, in order to remain flexible and minimize churn in the future.

#### Transparency

While SQLite is **not** a proprietary storage format, it was deemed "too opaque" for our needs. We want to ensure that users can easily understand and interact with the data, and synchronize it via a CLI tool.

#### Synchronization

One of our maintainers informed us of a few software-based solutions that could be used for synchronization, but expressed their concerns about sustainability. Our primary target for synchronization is Git, while attempting to avoid the possibility of merge conflicts.

### Strategy

Main discussion revolved around these two concepts:

- SQLite-first
- Document-first

While a document-first approach significantly increases complexity through side effects, it was decided that this would be the target approach moving forward, due to the aforementioned requirements.

### Considerations

It is worth noting that our current plan is considered naive.

- Many problems still unaccounted for.
- Previous preferences/tooling choices may need to be revisited.
- Implementation details are still vague.
- User preferences are not yet fully understood.

## Architecture

The `vault-core` package separates responsibilities into:

- VaultClient: Runs in the app (web/desktop). Holds Adapters for schema/metadata only. Uses RPC to talk to VaultService for operations.
- VaultService: Runs on a server or sidecar process. Holds Importers which implement parse/validate/upsert and own DB/migrations.

### Key concepts

- Adapter: Schema-only (drizzle schema and drizzleConfig). Optionally metadata for column descriptions.
- Importer: Encapsulates one data source workflow: id, name, adapter, validator, parse(blob), upsert(db, parsed), and optional views.
- Service DB: The service owns the database connection and migration function.

### Suggested RPC pattern (to be implemented by host app)

Define a minimal protocol to connect client and service. The exact transport is undetermined and left to the host app. A basic shape could include:

- importers.list -> returns available importers (id, name)
- importers.migrate { id } -> triggers service-side migration for a single importer
- import.importBlob { id, file } -> uploads a blob and triggers parse+upsert on the service
- schema.describe { id } -> returns human-readable schema info for an adapter (optional; client can compute this locally from Adapter if bundled)

### Lifecycle

- Client constructs VaultClient with a list of Adapters for type-safe UI and schema introspection.
- Service constructs VaultService with Importers and a DB connection. On startup, it runs migrations for all importers (or selectively).
- Client submits a requests via RPC. Service parses with the selected importer, validates, executes, and responds.
- Synchronization needs to occur via an interface, configured by the host.

### Synchronization

WIP

### Others

Details like transport, auth, streaming, retries, and backpressure are left TBD.
