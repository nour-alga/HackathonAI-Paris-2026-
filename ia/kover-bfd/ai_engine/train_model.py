"""
Utility script: trains a baseline IsolationForest on synthetic baseline traffic
and dumps it to `models/iso_forest.joblib`. Replace the synthetic dataset with
historical mempool aggregates in production.

Usage:
    python train_model.py
"""
from __future__ import annotations

from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import IsolationForest


def main() -> None:
    rng = np.random.default_rng(42)
    # Baseline: ~0-5 ETH/s, 0-50 tx/s
    volume_eth = rng.gamma(shape=2.0, scale=1.0, size=10_000)
    tx_count = rng.poisson(lam=15, size=10_000).astype(float)
    X = np.column_stack([volume_eth, tx_count])

    model = IsolationForest(
        n_estimators=200,
        contamination=0.01,
        max_samples="auto",
        random_state=42,
        n_jobs=-1,
    ).fit(X)

    out = Path(__file__).parent / "models" / "iso_forest.joblib"
    out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, out)
    print(f"saved {out}")


if __name__ == "__main__":
    main()
