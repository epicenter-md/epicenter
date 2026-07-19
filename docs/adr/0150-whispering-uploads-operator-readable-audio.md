# 0150. Whispering uploads operator-readable audio

- **Status:** Accepted
- **Date:** 2026-07-18
- **Amends:** [ADR-0090](0090-the-blob-layer-stays-plaintext-confidentiality-belongs-to-the-encrypting-consumer.md)

## Context

ADR-0090 leaves confidentiality to each blob consumer. Whispering must choose
whether hosted recordings are operator-readable or encrypted before upload.
Consumer-side encryption would require key creation, recovery, sharing, device
enrollment, rotation, and ciphertext metadata that the current product does not
otherwise need.

## Decision

Whispering uploads recording bytes in operator-readable plaintext. Transport
encryption, authenticated principal isolation, and storage-provider controls
remain mandatory, but the Whispering client does not encrypt audio before
placing it in the remote blob store.

## Consequences

Authenticated server operators and storage infrastructure can technically read
hosted recordings. The application can stream one finalized local blob directly
to its replica without an encryption envelope or key-management subsystem. The
UI and product documentation must not imply end-to-end encryption.

## Considered alternatives

- Consumer-side encryption: improves operator confidentiality but creates a
  durable key-management product and complicates cross-device recovery.
- Defer hosted recording upload: preserves the privacy question by withholding
  the cross-device durability feature the product has now chosen to ship.
