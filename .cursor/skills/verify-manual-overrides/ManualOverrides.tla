---- MODULE ManualOverrides ----
\* One card's hand-maintained data across daily syncs: a CDR-owned decision
\* field (fees.annual) a maintainer can correct and lock (`provenance correct`,
\* a hand `locked` entry, `provenance unlock`), an explained gap for that field
\* (`gaps`), and the signup offer slot (manual offers, `locked = ["offers"]`).
\* The merge, gap, offer slot and lock tables come from the real code through
\* ManualOverridesCode (tools/verify/overrides-table.ts); the sync step follows
\* proposeCard in src/sync/Sync.ts.
EXTENDS Naturals, ManualOverridesCode

CONSTANTS MaxSteps

CdrOffers == {"o1", "o2"}
Locked == {"Fresh", "Stale", "Undated"}

VARIABLES
  field,        \* fees.annual on the card: "none", "hand" or "cdr"
  lock,         \* section lock state: Unlocked, Fresh, Stale or Undated
  lockKind,     \* how the lock is written: "section" (provenance correct) or "exact"
  gap,          \* a gaps entry explains fees.annual
  cdrHas,       \* CDR publishes fees.annual
  offer,        \* the stored signup offer: "none", "o1", "o2" or "manual"
  cdrOffer,     \* the signup offer the sync would generate now ("none", o1, o2)
  offersLocked, \* "offers" is in the card's locked list
  lockedLost, manualLost, gapLostEmpty, gapBesideCdr, frozenChanged,
  steps

vars == <<field, lock, lockKind, gap, cdrHas, offer, cdrOffer, offersLocked,
          lockedLost, manualLost, gapLostEmpty, gapBesideCdr, frozenChanged, steps>>

MRow(k, present, cdr, g) == CHOOSE r \in MergeRows : r[1] = k /\ r[2] = present /\ r[3] = cdr /\ r[4] = g
SRow(e, gen, l) == (CHOOSE r \in SlotRows : r[1] = e /\ r[2] = gen /\ r[3] = l)[4]
LRow(s, e) == (CHOOSE r \in LockRows : r[1] = s /\ r[2] = e)[3]

History == <<lockedLost, manualLost, gapLostEmpty, gapBesideCdr, frozenChanged>>

Init ==
  /\ field = "cdr" /\ lock = "Unlocked" /\ lockKind = "section" /\ gap = FALSE /\ cdrHas = TRUE
  /\ offer = "none" /\ cdrOffer = "o1" /\ offersLocked = FALSE
  /\ lockedLost = FALSE /\ manualLost = FALSE /\ gapLostEmpty = FALSE
  /\ gapBesideCdr = FALSE /\ frozenChanged = FALSE
  /\ steps = 0

Step == steps < MaxSteps /\ steps' = steps + 1

\* `provenance correct --section fees`: a hand value, and the section locked.
MaintainerCorrects ==
  /\ Step /\ field' = "hand" /\ lock' = LRow(lock, "Correct") /\ lockKind' = "section"
  /\ UNCHANGED <<gap, cdrHas, offer, cdrOffer, offersLocked>> /\ UNCHANGED History

\* A hand edit adds "fees.annual" to `locked` with no section review.
MaintainerLocksField ==
  /\ Step /\ lock = "Unlocked" /\ lock' = "Undated" /\ lockKind' = "exact"
  /\ UNCHANGED <<field, gap, cdrHas, offer, cdrOffer, offersLocked>> /\ UNCHANGED History

\* `provenance unlock --path fees.annual`.
MaintainerUnlocks ==
  /\ Step /\ lock \in Locked /\ lock' = LRow(lock, "Unlock")
  /\ UNCHANGED <<field, lockKind, gap, cdrHas, offer, cdrOffer, offersLocked>> /\ UNCHANGED History

\* A maintainer records why fees.annual is empty.
MaintainerExplainsGap ==
  /\ Step /\ field = "none" /\ ~gap /\ gap' = TRUE
  /\ UNCHANGED <<field, lock, lockKind, cdrHas, offer, cdrOffer, offersLocked>> /\ UNCHANGED History

\* A maintainer writes a `source = "manual"` signup offer.
MaintainerWritesOffer ==
  /\ Step /\ offer # "manual" /\ offer' = "manual"
  /\ UNCHANGED <<field, lock, lockKind, gap, cdrHas, cdrOffer, offersLocked>> /\ UNCHANGED History

\* A maintainer adds "offers" to `locked`.
MaintainerFreezesOffers ==
  /\ Step /\ ~offersLocked /\ offersLocked' = TRUE
  /\ UNCHANGED <<field, lock, lockKind, gap, cdrHas, offer, cdrOffer>> /\ UNCHANGED History

\* The issuer starts or stops publishing the fee, or changes its signup offer.
CdrChanges ==
  /\ Step
  /\ \/ cdrHas' = ~cdrHas /\ UNCHANGED cdrOffer
     \/ \E o \in ({"none"} \cup CdrOffers) \ {cdrOffer} : cdrOffer' = o /\ UNCHANGED cdrHas
  /\ UNCHANGED <<field, lock, lockKind, gap, offer, offersLocked>> /\ UNCHANGED History

\* One sync: mergeCard and observeMergedGaps, then applyOffers/combineOffers.
SyncRuns ==
  LET kind == IF lock = "Unlocked" THEN "none" ELSE lockKind
      m == MRow(kind, field # "none", cdrHas, gap)
      nextField == IF m[5] = "hand" THEN field ELSE m[5]
      existing == IF offer = "none" THEN "none" ELSE IF offer = "manual" THEN "manual" ELSE "cdr"
      s == SRow(existing, cdrOffer # "none", offersLocked)
      nextOffer == IF s = "old" THEN offer ELSE IF s = "new" THEN cdrOffer ELSE s
  IN /\ Step
     /\ field' = nextField
     /\ gap' = m[6]
     /\ offer' = nextOffer
     /\ lockedLost' = (lockedLost \/ (lock \in Locked /\ field # "none" /\ nextField # field))
     /\ manualLost' = (manualLost \/ (offer = "manual" /\ nextOffer # "manual"))
     /\ gapLostEmpty' = (gapLostEmpty \/ (gap /\ ~m[6] /\ nextField = "none"))
     /\ gapBesideCdr' = (gapBesideCdr \/ (m[6] /\ nextField = "cdr"))
     /\ frozenChanged' = (frozenChanged \/ (offersLocked /\ nextOffer # offer))
     /\ UNCHANGED <<lock, lockKind, cdrHas, cdrOffer, offersLocked>>

Next ==
  \/ MaintainerCorrects
  \/ MaintainerLocksField
  \/ MaintainerUnlocks
  \/ MaintainerExplainsGap
  \/ MaintainerWritesOffer
  \/ MaintainerFreezesOffers
  \/ CdrChanges
  \/ SyncRuns

Spec == Init /\ [][Next]_vars

\* Rules a maintainer agrees to.
LockedValueSurvivesSync == ~lockedLost
ManualOfferSurvivesSync == ~manualLost
GapKeptWhileFieldEmpty == ~gapLostEmpty
NoGapBesideCdrValue == ~gapBesideCdr
FrozenOffersUnchanged == ~frozenChanged
AgingNeverUnlocks ==
  \A r \in LockRows : (r[2] \in {"AgedYoung", "AgedOld"} /\ r[1] # "Unlocked") => r[3] # "Unlocked"
====
