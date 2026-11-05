# 0002. Garage as the S3 compatible store

- **Status**: accepted
- **Date**: 2026-11-05
- **Spec**: [0007 Stack architecture and operations layer](../specs/0007-stack-architecture-operations-layer/index.md)

## Context

Each install needs an object store for files such as exports, labels, and uploaded documents. Spec
0007 asks for a self run, S3 compatible server on each host, in the dev and self host Compose too,
so the product does not depend on a cloud vendor. The [hosting research](../research/0001-egypt-hosting-options.md)
found that no Egyptian provider confirms an S3 service, so the store has to travel with the install.

MinIO is ruled out: its community edition stopped publishing images in October 2025 and its
repository is archived. The options left were Garage, SeaweedFS, and RustFS.

- **SeaweedFS** is capable but is a larger system (master, volume, and filer servers) than one
  client install needs.
- **RustFS** is newer, and a young project is a risk for data that a client's operations depend on.
- **Garage** is a small single binary built for self hosting, with per key bucket permissions that
  fit one bucket per client.

## Decision

We will use Garage (Deuxfleurs, image `dxflrs/garage`, pinned to an exact version) as the S3
compatible store in the dev Compose and in each client install, with one bucket and one access key
per client. Garage is AGPL licensed; we run the server unmodified as a separate container and talk
to it only over the S3 api, never linking its code into ours.

## Consequences

- A fresh Garage has no storage layout, bucket, or key. `pnpm bootstrap` sets them up for local
  development; the production Compose needs the same one time step (follow up with feature 16).
- The api talks plain S3 (region `garage`, path style addressing), so switching store later means
  changing endpoint settings only.
- Garage's own command line tool (`garage layout`, `bucket`, `key`) is the admin surface; there is
  no console UI to maintain.
- If we ever modify Garage's source, the AGPL source offer obligation applies; revisit this record
  before doing so.
