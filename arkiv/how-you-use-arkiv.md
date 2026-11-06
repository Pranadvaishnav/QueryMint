# How QueryMint uses Arkiv

The buyer query reads actual publisher records from the `querymint.record.v1` schema using indexed dataset/category fields. The coordinator checks each entity owner against the publisher registered for the referenced dataset on Whitechain. Publisher-owned dataset manifests and records are visible to the publisher dashboard and the buyer preview; receipts connect the returned record hashes to settlement.

Expiry removes stale offers and records from the query surface. Only fields needed for discovery are indexed. These choices affect what buyers can find and what publishers control; Arkiv is not used only as an append-only log.

Implementation details, live writer addresses, and a reproducible query will be added after actual Rabdi writes are verified.
