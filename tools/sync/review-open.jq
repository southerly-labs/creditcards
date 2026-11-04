.[0] as $sync | .[1] as $pages |
(($sync.rewards.review | length) + ($sync.bonus.review | length) +
 ($sync.held | length) + ([$sync.holds[] | select(.kind == "approve" and (has("decision") | not))] | length) +
 ($sync.brandErrors | length) + ($sync.discontinued | length) +
 ([$pages[] | select((.missing | length > 0) or .error != null or .attention != null)] | length))
