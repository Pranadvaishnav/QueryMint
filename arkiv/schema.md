# QueryMint Arkiv schema (draft)

All entities are public. Dataset owners publish their own profiles, manifests, and records. The coordinator owns query receipts it writes. Expiry should follow the dataset retention policy; start with the shortest practical lifetime and extend still-active records.

| Schema | Queried/indexed fields | Stored fields | Owner |
|---|---|---|---|
| `querymint.publisher.v1` | publisher address, status | display name, public payout address | Publisher |
| `querymint.dataset.v1` | dataset ID (`key`), publisher address, category, status | title, description, schema version, policy mirror | Publisher |
| `querymint.record.v1` | dataset ID (`key`), content hash (`key`), category and selected search attributes | entity key reference, payload hash (`key`), encrypted payload | Publisher |
| `querymint.receipt.v1` | query ID (`key`), manifest hash (`key`), status | settlement tx hash (`key`), result root (`key`), allocation summary | Coordinator |

The installed SDK version `@arkiv-network/sdk@1.0.1` does not expose a `bytes32()` column constructor. Its documented `key()` type is a 32-byte indexed value and is used for dataset IDs and hashes. Its `bytes()` type is non-indexable, so payload discovery filters use indexed category and content-hash keys instead.

The contract is authoritative for dataset ownership, pricing, coordinator grants, expiry, and payout limits. Arkiv manifest terms are discovery metadata only. Coordinator query results must be owner-checked against current Whitechain registration. No plaintext licensed payload or decryption key belongs on Arkiv.

The implementation is pinned to `@arkiv-network/sdk@1.0.1`. The writer and query script use the installed schema constructors and query API. Pagination uses an indexed keyset predicate (`$key > lastKey`) with ascending `$key` ordering and a page limit (maximum 100), not an assumed offset method. The writer script is reproducible, but a real Rabdi write/query has not yet been run because no Arkiv access key and publisher wallets were supplied.
