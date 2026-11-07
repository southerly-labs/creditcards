.[0] as $sync | .[1] as $pages |
$sync | {
  holds: [.holds[] | select(.state._tag == "AwaitingApproval") | .id],
  held: [.held[].card],
  earn: [.rewards.review[].card],
  bonus: [.bonus.review[].card],
  earn_check: [$pages[] | select((.missing | length > 0) or .attention != null or (.error != null and .known_blocked == null)) | {card, url, error, attention, missing}],
  discontinued: .discontinued,
  brands: [.brandErrors[].brand]
}
