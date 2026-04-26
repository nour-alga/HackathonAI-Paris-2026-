"""Wrapper d'entraînement Path LSTM — délègue à backend.models.path_lstm.train_path_lstm()."""
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.models.path_lstm import train_path_lstm  # noqa: E402


def main() -> int:
    epochs = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    dataset = ROOT / "salam_ammari_dataset" / "Dataset" / "Dataset.csv"
    out = ROOT / "backend" / "models" / "path_lstm.pt"

    if not dataset.exists():
        print(f"[KO] Dataset absent : {dataset}")
        return 1

    print(f"[train_lstm] epochs={epochs}, dataset={dataset}, out={out}")
    t0 = time.time()
    train_path_lstm(dataset=str(dataset), model_path=str(out), epochs=epochs, batch_size=32)
    print(f"[train_lstm] terminé en {time.time()-t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
