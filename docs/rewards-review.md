# Rewards section review states

Optional rewards.earn_review and rewards.bonus_review objects carry state:
unknown, present, or none. Absence of an object is unknown review status, never
evidence of reviewed absence. Existing earn/bonus arrays and source/hash metadata
remain unchanged and supported.

Parser success writes present without reviewed_at. Failed earn parsing writes
unknown while retaining the existing legacy rates. Removing a parser bonus writes
unknown: missing CDR text does not prove that no offer exists.

Manual stamp commands record present for nonempty arrays or none for empty arrays
(including --none), with reviewed_at set to the actual UTC date of stamping.
None means no fixed earn rate or no current points signup offer, respectively;
it does not assert absence of cashback or other benefits. Dates are never inferred
from sync timestamps, source updates, or legacy manual flags.

Manual sections remain protected. Changed source hashes still enter the existing
review queue, and failed issuer-page quote checks still request review. A review
object describes the last recorded assessment, not a guarantee that sources are
still current; consumers must retain those stale-source signals. Existing manual
records are not backfilled because their actual review dates are unknown.
