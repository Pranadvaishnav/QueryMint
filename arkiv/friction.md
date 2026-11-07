# Arkiv integration friction and validation status

## Verified from installed SDK 1.0.1

- The schema package has no `bytes32()` constructor. `key()` is the indexed 32-byte value type; `bytes()` is available for non-indexed encrypted payload bytes.
- Query pagination supports ordered indexed-key traversal with `.orderBy(asc("$key")).limit(n)` and a keyset continuation predicate `gt("$key", key(lastKey))`. The implementation caps page size at 100.
- A shared category query is needed for multiple publishers. The returned Arkiv `$owner` must be checked against the publisher registered for the returned on-chain dataset ID.

## Live status and remaining verification

The project owner reports successful Rabdi publishing for two publishers and four encrypted records. On 2026-11-07 the production coordinator returned both active datasets and a quote matching four records; its discovery path performs owner and current on-chain-policy checks. This turn did not submit Arkiv writes or query the Arkiv indexer directly. Indexing delay, long-term expiry behavior, and live transaction cost remain unmeasured here. The reproducible roundtrip script remains useful for a fresh isolated test, but must not be pointed at the existing publisher data for a write.

## Improvement request for Arkiv

For a future SDK/doc update, an end-to-end multi-owner example with a keyset-pagination recipe, indexed-key schema examples, and expected indexing consistency behavior would reduce integration ambiguity. This is a developer recommendation based on implementation work, not a report of a failed network operation.
