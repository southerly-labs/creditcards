# Public API contract

The runtime contract is src/api/contract.ts, shared by build output and browser
decoding. Storage schemas remain in src/model/schema.ts. Public card and program
schemas deliberately project those field definitions, so additive nested domain
fields are retained. Cards omit locked; programs omit aliases and priority;
issuers expose name, website and cards. All other existing fields, including
CDR identifiers, review hashes, source labels and earn_check evidence, remain
public. These are descriptive evidence, not a guarantee of verification.

New builds emit schema_version 1. The decoder also accepts legacy documents
without version or metadata. generated_at is the build serialization time,
not source freshness or the time of a successful sync.

freshness.cdr_latest_product_updated_at is the latest parseable, timezone-qualified
CDR product update timestamp actually stored in this dataset, normalized to UTC.
It is omitted when none is known. cdr_products_with_known_updated_at counts those
timestamps; card_count includes discontinued cards. This maximum does not mean all
cards are current, and does not date manual rewards edits, issuer page checks or
program valuations. No fetch time or review date is inferred.
