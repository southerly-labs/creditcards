---- MODULE RewardsReview ----
\* One card's earn_state (or signup_state) while the issuer edits its CDR
\* loyalty text, the daily sync reads it (earnRead/bonusRead, planRewards,
\* planBonus), the sync posts the rewards-review issue, and a maintainer answers
\* with /earn-none or /bonus-none (review-command.yml, applyComment, stamp,
\* stampBonus). The review statechart and comment parser tables come from the
\* real code through RewardsReviewCode (tools/verify/review-table.ts).
EXTENDS Naturals, RewardsReviewCode

CONSTANTS MaxSteps

\* Model scope: text A cannot be parsed, B parses, C names no offer.
Texts == {"A", "B", "C"}
Outcome == [t \in Texts |-> IF t = "A" THEN "unreadable" ELSE IF t = "B" THEN "parsed" ELSE "nothing"]
NoText == "none"

VARIABLES
  text,       \* the issuer's current CDR text (its hash)
  tag,        \* earn_state._tag stored on the card
  hash,       \* earn_state.hash (NoText when Unread)
  outcome,    \* earn_state.outcome for Reviewed and Stale ("-" otherwise)
  listed,     \* the text hash the rewards-review issue lists for the card
  lastRead,   \* the text the last sync read
  freshRead,  \* no stamp has landed since that read
  badStamp,   \* history: a stamp recorded a text the issue never listed
  overwrote,  \* history: a sync read replaced a manual review
  steps

vars == <<text, tag, hash, outcome, listed, lastRead, freshRead, badStamp, overwrote, steps>>

RRow(t, o, kind, same, eo) ==
  CHOOSE r \in ReviewRows : r[1] = t /\ r[2] = o /\ r[3] = kind /\ r[4] = same /\ r[5] = eo

Needs(t, o) == (CHOOSE r \in NeedsReviewRows : r[1] = t /\ r[2] = o)[3]

Manual == {"Reviewed", "Stale"}

Init ==
  /\ text = "A"
  /\ tag = "Unread" /\ hash = NoText /\ outcome = "-"
  /\ listed = NoText
  /\ lastRead = NoText
  /\ freshRead = FALSE
  /\ badStamp = FALSE
  /\ overwrote = FALSE
  /\ steps = 0

Step == steps < MaxSteps /\ steps' = steps + 1

\* The issuer edits its loyalty or bonus text.
IssuerEditsText ==
  /\ Step
  /\ \E t \in Texts \ {text} : text' = t
  /\ UNCHANGED <<tag, hash, outcome, listed, lastRead, freshRead, badStamp, overwrote>>

\* The daily sync sends Read to the review statechart, then the
\* "Update earn-rate review issue" step rewrites the issue body.
SyncReads ==
  LET r == RRow(tag, outcome, "Read", text = hash, Outcome[text])
      nextHash == IF r[7] = "none" THEN NoText ELSE IF r[7] = "old" THEN hash ELSE text
  IN /\ Step
     /\ tag' = r[6]
     /\ hash' = nextHash
     /\ outcome' = r[8]
     /\ listed' = IF Needs(r[6], r[8]) THEN text ELSE NoText
     /\ lastRead' = text
     /\ freshRead' = TRUE
     /\ overwrote' = (overwrote \/ (tag \in Manual /\ r[6] \notin Manual))
     /\ UNCHANGED <<text, badStamp>>

\* A maintainer reads the card in the issue and comments /earn-none, either
\* copying the issue's `issuer/card@hash` (pinned) or the bare `issuer/card`.
\* applyComment pins a bare card to the hash the issue body lists, and stamp()
\* refuses a hash that no longer matches the live CDR text (textChanged in
\* src/rewards/review.ts). StampLandsRows is the real applyComment's answer.
Lands(pinned, changed) == (CHOOSE r \in StampLandsRows : r[1] = pinned /\ r[2] = changed)[3]

MaintainerStamps ==
  \E pinned \in BOOLEAN, o \in {"none", "present"} :
    LET parsed == IF pinned THEN PinnedStampAccepted ELSE BareStampAccepted
        accepted == parsed /\ Lands(pinned, text # listed)
        r == RRow(tag, outcome, "Stamp", text = hash, o)
    IN /\ Step
       /\ listed # NoText
       /\ accepted
       /\ tag' = r[6]
       /\ hash' = IF r[7] = "old" THEN hash ELSE text
       /\ outcome' = r[8]
       /\ freshRead' = FALSE
       /\ badStamp' = (badStamp \/ text # listed)
       /\ UNCHANGED <<text, listed, lastRead, overwrote>>

Next ==
  \/ IssuerEditsText
  \/ SyncReads
  \/ MaintainerStamps

Spec == Init /\ [][Next]_vars

\* Rules a maintainer agrees to.
StampCoversListedText == ~badStamp
ChangedTextReflagged == (freshRead /\ tag = "Reviewed") => hash = lastRead
ParserNeverReplacesReview == ~overwrote
UnreadableTextQueued ==
  (freshRead /\ Outcome[lastRead] = "unreadable" /\ ~(tag = "Reviewed" /\ hash = lastRead)) => Needs(tag, outcome)
====
