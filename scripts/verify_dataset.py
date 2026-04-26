"""Sanity check du dataset Salam Ammari avant entraînement."""
import csv
import sys
from collections import Counter
from pathlib import Path

CSV_PATH = Path(__file__).resolve().parent.parent / "salam_ammari_dataset" / "Dataset" / "Dataset.csv"
EXPECTED = {"from_address", "to_address", "value", "block_timestamp", "from_scam", "to_scam", "to_category"}


def main() -> int:
    if not CSV_PATH.exists():
        print(f"[KO] {CSV_PATH} introuvable.")
        print("    → Place le CSV Kaggle (Salam Ammari) à cet emplacement.")
        return 1

    with open(CSV_PATH, "r", encoding="utf-8", errors="ignore") as f:
        reader = csv.DictReader(f)
        cols = set(reader.fieldnames or [])
        rows = list(reader)

    missing = EXPECTED - cols
    if missing:
        print(f"[WARN] Colonnes manquantes : {missing}")
        print(f"       Colonnes trouvées : {sorted(cols)}")
    else:
        print(f"[OK] Toutes les colonnes attendues sont présentes.")

    n = len(rows)
    fraud = sum(1 for r in rows if str(r.get("from_scam", "0")).strip() in ("1", "1.0", "True", "true"))
    cats = Counter((r.get("to_category") or "unknown").strip() for r in rows)

    print(f"\nLignes total       : {n:,}")
    print(f"Taux from_scam=1   : {fraud:,} ({100*fraud/max(n,1):.2f}%)")
    print(f"Top 10 catégories  :")
    for cat, c in cats.most_common(10):
        print(f"  {cat:30s} {c:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
