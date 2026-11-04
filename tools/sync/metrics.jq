.[0] as $sync | .[1] as $pages | (.[2] // {}) as $previous |
($sync.date // $date) as $today |
([
  ($sync.holds[]? | select(.kind == "approve" and (has("decision") | not)) | {id: ("hold:" + .id), reason: "held_change", card, since: (.since // $today)}),
  ($sync.held[]? | {id: ("held:" + .card), reason: "held_card", card}),
  ($sync.rewards.review[]? | {id: ("earn:" + .card), reason: "earn_review", card}),
  ($sync.bonus.review[]? | {id: ("bonus:" + .card), reason: "bonus_review", card}),
  ($sync.discontinued[]? | {id: ("discontinued:" + .), reason: "discontinued", card: .}),
  ($sync.brandErrors[]? | {id: ("brand:" + .brand), reason: "brand_error", brand: .brand, url: $run}),
  ($pages[]? | select((.missing | length > 0) or .attention != null or (.error != null and .known_blocked == null)) |
    {id: ("page:" + .card + ":" + .url), reason: (if .attention != null then "blocked_page_changed" elif .error != null then "unreadable_page" else "earn_page_changed" end), card, url}),
  ($outcomes | to_entries[] | select(.value != "success") | {id: ("workflow:" + .key), reason: "workflow_failure", url: $run}),
  (if $sync == null then {id: "report:sync", reason: "missing_sync_report", url: $run} else empty end),
  (if $pages == null then {id: "report:pages", reason: "missing_earn_report", url: $run} else empty end),
  (if $sync == null or $pages == null then $previous.open_human_tasks[]? else empty end)
] | unique_by(.id) | map(. as $task |
  ([$previous.open_human_tasks[]? | select(.id == $task.id and .reason == $task.reason)] | first) as $old |
  . + {since: ($old.since // .since // $today)})) as $tasks |
((if $previous.date == $today then $previous.opened_today // [] else [] end) +
 ($tasks | map(select(.since == $today))) | unique_by([.id, .reason])) as $opened |
{
  date: $today,
  run: $run,
  workflow_results: $outcomes,
  open_human_tasks: $tasks,
  known_blocked: [$pages[]? | select(.known_blocked != null) | {card, url, evidence: .error, since: .known_blocked.since, reason: .known_blocked.reason}],
  sync_clear: (($tasks | length) == 0 and ([$pages[]? | select(.error != null)] | length) == 0),
  opened_today: $opened,
  tasks_opened_today: ($opened | group_by(.reason) | map({key: .[0].reason, value: length}) | from_entries)
}
