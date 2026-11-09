---- MODULE ReviewQueue ----
\* One issuer earn page (rewards.earn_check) and the review queue around it
\* across daily sync.yml runs: `rewards check --record-blocked` classifies the
\* page and records known_blocked, `review issue rewards` plans the
\* rewards-review issue, and `review tasks` (tools/sync/record-metrics.sh)
\* carries the open human tasks on the metrics branch. The classification,
\* issue and task tables come from the real code through ReviewQueueCode
\* (tools/verify/queue-table.ts).
EXTENDS Naturals, ReviewQueueCode

CONSTANTS MaxDay

Errors == {"e1", "e2"}
StaleDays == 30

VARIABLES
  day,        \* today's date, as a day number
  page,       \* what fetching the page gives now: "ok" or an error
  blocked,    \* known_blocked.evidence stored on the card ("none" when absent)
  bsince,     \* known_blocked.since
  items,      \* other open review items (held changes, earn or bonus reviews)
  issue,      \* the rewards-review issue: "absent" or "open"
  taskSince,  \* the page's open human task `since` (0 when not open)
  prev,       \* page status at the last run whose page check succeeded
  streak,     \* history: first run day of the page's current stretch of review
  missed, noisy, issueWrong, sinceWrong, dropped

vars == <<day, page, blocked, bsince, items, issue, taskSince, prev, streak,
          missed, noisy, issueWrong, sinceWrong, dropped>>

CRow(b, r) == CHOOSE x \in ClassifyRows : x[1] = b /\ x[2] = r
IRow(o, i, c) == (CHOOSE x \in IssueRows : x[1] = o /\ x[2] = i /\ x[3] = c)[4]
TRow(p, s) == CHOOSE x \in TaskRows : x[1] = p /\ x[2] = s

Init ==
  /\ day = 1 /\ page = "ok" /\ blocked = "none" /\ bsince = 0
  /\ items = FALSE /\ issue = "absent" /\ taskSince = 0 /\ prev = "ok" /\ streak = 0
  /\ missed = FALSE /\ noisy = FALSE /\ issueWrong = FALSE /\ sinceWrong = FALSE /\ dropped = FALSE

Env == <<blocked, bsince, issue, taskSince, prev, streak, missed, noisy, issueWrong, sinceWrong, dropped>>

NewDay == day < MaxDay /\ day' = day + 1 /\ UNCHANGED <<page, items>> /\ UNCHANGED Env
MonthPasses == day + StaleDays <= MaxDay /\ day' = day + StaleDays /\ UNCHANGED <<page, items>> /\ UNCHANGED Env

\* The issuer page starts failing, fails differently, or reads again.
PageChanges == \E p \in ({"ok"} \cup Errors) \ {page} : page' = p /\ UNCHANGED <<day, items>> /\ UNCHANGED Env

\* Some other review item opens or is resolved.
ItemsChange == items' = ~items /\ UNCHANGED <<day, page>> /\ UNCHANGED Env

\* One sync.yml run. checkOk is the "Check issuer earn pages" outcome; when it
\* fails there is no earn-check.json, so the issue step runs without --checked
\* and record-metrics.sh passes no page report.
SyncRuns ==
  \E checkOk \in BOOLEAN :
    LET bkey == IF blocked = "none" THEN "none" ELSE IF day - bsince >= StaleDays THEN "e1-old" ELSE "e1-recent"
        rel == IF page = "ok" THEN "ok" ELSE IF blocked = "none" \/ page = blocked THEN "e1" ELSE "e2"
        row == CRow(bkey, rel)
        needs == checkOk /\ row[3]
        counts == checkOk /\ row[4]
        action == IRow(issue = "open", items \/ counts, checkOk)
        tr == TRow(IF taskSince # 0 THEN "open" ELSE "none", IF ~checkOk THEN "missing" ELSE IF needs THEN "needs" ELSE "fine")
        nextTask == IF ~tr[3] THEN 0 ELSE IF tr[4] = "today" THEN day ELSE taskSince
        nextIssue == IF action \in {"Create", "Edit"} THEN "open" ELSE IF action = "Close" THEN "absent" ELSE issue
        inStretch == needs \/ (~checkOk /\ taskSince # 0)
        nextStreak == IF ~inStretch THEN 0 ELSE IF streak = 0 THEN day ELSE streak
    IN /\ blocked' = IF ~checkOk THEN blocked ELSE IF row[5] = "none" THEN "none" ELSE page
       /\ bsince' = IF ~checkOk THEN bsince ELSE IF row[5] = "none" THEN 0
                    ELSE IF row[5] \in {"e1-today", "e2-today"} THEN day ELSE bsince
       /\ issue' = nextIssue
       /\ taskSince' = nextTask
       /\ prev' = IF checkOk THEN page ELSE prev
       /\ streak' = nextStreak
       /\ missed' = (missed \/ (checkOk /\ page # prev /\ ~needs))
       /\ noisy' = (noisy \/ (checkOk /\ page = prev /\ page # "ok" /\ bkey = "e1-recent" /\ needs))
       /\ issueWrong' = (issueWrong \/ (checkOk /\ ((page # "ok" \/ items \/ needs) # (nextIssue = "open"))))
       /\ sinceWrong' = (sinceWrong \/ (nextTask # 0 /\ nextTask # nextStreak))
       /\ dropped' = (dropped \/ (~checkOk /\ taskSince # 0 /\ nextTask = 0))
       /\ UNCHANGED <<day, page, items>>

Next == NewDay \/ MonthPasses \/ PageChanges \/ ItemsChange \/ SyncRuns

Spec == Init /\ [][Next]_vars

\* Rules a maintainer agrees to.
EveryPageChangeRaised == ~missed
StandingBlockStaysQuiet == ~noisy
IssueOpenExactlyWhileWorkRemains == ~issueWrong
TaskKeepsFirstDay == ~sinceWrong
FailedCheckKeepsTasks == ~dropped
====
