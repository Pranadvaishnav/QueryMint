# Arkiv integration friction and validation status

## Verified from installed SDK 1.0.1

- The schema package has no `bytes32()` constructor. `key()` is the indexed 32-byte value type; `bytes()` is available for non-indexed encrypted payload bytes.
- Query pagination supports ordered indexed-key traversal with `.orderBy(asc("$key")).limit(n)` and a keyset continuation predicate `gt("$key", key(lastKey))`. The implementation caps page size at 100.
- A shared category query is needed for multiple publishers. The returned Arkiv `$owner` must be checked against the publisher registered for the returned on-chain dataset ID.

## Still unverified on Rabdi

The checked-in roundtrip script can write two synthetic publisher datasets and four encrypted records, query them in pages, check owner attribution, verify hashes, and decrypt locally. It has not been executed against Rabdi because no Arkiv access key or publisher signing keys were provided. Actual endpoint behavior, indexing delay, expiry semantics, and transaction-cost observations therefore remain pending. No testnet success is claimed.

## Improvement request for Arkiv

For a future SDK/doc update, an end-to-end multi-owner example with a keyset-pagination recipe, indexed-key schema examples, and expected indexing consistency behavior would reduce integration ambiguity. This is a developer recommendation based on implementation work, not a report of a failed network operation.
