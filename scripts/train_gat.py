"""Wrapper d'entraînement GAT — délègue à gat_scorer.train()."""
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import gat_scorer  # noqa: E402


def main() -> int:
    epochs = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    print(f"[train_gat] epochs={epochs}, dataset={gat_scorer.CSV_PATH}")
    if not gat_scorer.CSV_PATH.exists():
        print(f"[KO] Dataset absent : {gat_scorer.CSV_PATH}")
        return 1

    t0 = time.time()
    gat_scorer.train(epochs=epochs)
    print(f"[train_gat] terminé en {time.time()-t0:.1f}s — checkpoint : {gat_scorer.MODEL_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
