"""
Preprocessing du dataset Elliptic pour l'entraînement du GAT.

Dataset : https://www.kaggle.com/datasets/ellipticco/elliptic-data-set
Fichiers attendus dans backend/data/training/elliptic/ :
  - elliptic_txs_features.csv  (203,769 transactions × 166 features)
  - elliptic_txs_classes.csv   (labels : 1=illicit, 2=licit, unknown=ignore)
  - elliptic_txs_edgelist.csv  (arêtes du graphe)

Usage :
  python -m backend.data.preprocessing.elliptic_processor
"""
import os
import numpy as np
import pandas as pd
import torch
from torch_geometric.data import Data
from sklearn.preprocessing import StandardScaler


ELLIPTIC_DIR = "backend/data/training/elliptic"
OUTPUT_PATH = "backend/data/training/elliptic_graph.pt"


def load_and_process() -> Data:
    print("Chargement des fichiers Elliptic...")

    features_path = os.path.join(ELLIPTIC_DIR, "elliptic_txs_features.csv")
    classes_path = os.path.join(ELLIPTIC_DIR, "elliptic_txs_classes.csv")
    edges_path = os.path.join(ELLIPTIC_DIR, "elliptic_txs_edgelist.csv")

    # Features : colonne 0 = tx_id, colonne 1 = time_step, colonnes 2-166 = features
    features_df = pd.read_csv(features_path, header=None)
    features_df.columns = ["tx_id", "time_step"] + [f"f{i}" for i in range(164)]

    # Labels : 1=illicit → 1, 2=licit → 0, unknown → -1
    classes_df = pd.read_csv(classes_path)
    classes_df.columns = ["tx_id", "class"]
    classes_df["label"] = classes_df["class"].map({"1": 1, "2": 0, 1: 1, 2: 0}).fillna(-1).astype(int)

    # Arêtes
    edges_df = pd.read_csv(edges_path, header=None, names=["src", "dst"])

    # Mapping tx_id → index continu
    all_ids = features_df["tx_id"].tolist()
    id_to_idx = {tx_id: idx for idx, tx_id in enumerate(all_ids)}

    # Features matrix (normalisation)
    feature_cols = [f"f{i}" for i in range(164)]
    X = features_df[feature_cols].values.astype(np.float32)
    scaler = StandardScaler()
    X = scaler.fit_transform(X)

    # Labels
    merged = features_df[["tx_id"]].merge(classes_df[["tx_id", "label"]], on="tx_id", how="left")
    y = merged["label"].fillna(-1).astype(int).values

    # Arêtes → format PyG [2, num_edges]
    valid_edges = edges_df[
        edges_df["src"].isin(id_to_idx) & edges_df["dst"].isin(id_to_idx)
    ]
    src = [id_to_idx[s] for s in valid_edges["src"]]
    dst = [id_to_idx[d] for d in valid_edges["dst"]]
    edge_index = torch.tensor([src, dst], dtype=torch.long)

    # Masques train/val/test (uniquement sur les nœuds labellisés)
    labeled_mask = torch.tensor(y != -1, dtype=torch.bool)
    labeled_indices = labeled_mask.nonzero(as_tuple=True)[0]
    n_labeled = labeled_indices.size(0)

    perm = torch.randperm(n_labeled)
    train_end = int(0.7 * n_labeled)
    val_end = int(0.85 * n_labeled)

    train_mask = torch.zeros(len(y), dtype=torch.bool)
    val_mask = torch.zeros(len(y), dtype=torch.bool)
    test_mask = torch.zeros(len(y), dtype=torch.bool)

    train_mask[labeled_indices[perm[:train_end]]] = True
    val_mask[labeled_indices[perm[train_end:val_end]]] = True
    test_mask[labeled_indices[perm[val_end:]]] = True

    data = Data(
        x=torch.tensor(X, dtype=torch.float),
        edge_index=edge_index,
        y=torch.tensor(y, dtype=torch.long),
        train_mask=train_mask,
        val_mask=val_mask,
        test_mask=test_mask,
    )

    torch.save(data, OUTPUT_PATH)
    illicit = (torch.tensor(y) == 1).sum().item()
    licit = (torch.tensor(y) == 0).sum().item()
    print(f"Graphe sauvegardé : {len(y)} nœuds | {edge_index.size(1)} arêtes")
    print(f"Labels : {illicit} illicites | {licit} licites | {len(y)-illicit-licit} inconnus")
    return data


if __name__ == "__main__":
    load_and_process()
