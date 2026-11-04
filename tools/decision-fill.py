"""Report assigned decision-field coverage; run with Python 3.11 or later."""

import pathlib
import tomllib

FIELDS = (
    "fees.foreign_txn_pct",
    "rates.purchase",
    "fees.annual",
    "limits.min_credit",
    "rates.cash_advance",
    "rates.interest_free_days",
    "fees.late_payment",
    "network",
    "url",
)


def has(card, field):
    value = card
    for key in field.split("."):
        if not isinstance(value, dict) or key not in value:
            return False
        value = value[key]
    return True


ROOT = pathlib.Path(__file__).resolve().parents[1]
cards = []
for path in sorted((ROOT / "data/issuers").glob("*/cards/*.toml")):
    card = tomllib.loads(path.read_text())
    if card["status"] == "active":
        cards.append((path.relative_to(ROOT), card))

print(f"Active cards: {len(cards)}")
for field in FIELDS:
    missing = [(path, card) for path, card in cards if not has(card, field)]
    filled = len(cards) - len(missing)
    percent = 100 * filled / len(cards) if cards else 0
    gaps = {
        str(path): gap["reason"]
        for path, card in missing
        for gap in card.get("gaps", [])
        if gap["field"] == field
    }
    explained = filled + len(gaps)
    covered = 100 * explained / len(cards) if cards else 0
    print(
        f"{field}: {filled}/{len(cards)} ({percent:.1f}%); "
        f"filled or explained {explained}/{len(cards)} ({covered:.1f}%)"
    )
    for path, _ in missing:
        reason = gaps.get(str(path))
        print(f"  {'gap ' + reason if reason else 'missing'}: {path}")
for path, card in cards:
    for gap in card.get("gaps", []):
        if has(card, gap["field"]):
            print(f"stale gap: {path} {gap['field']}")
