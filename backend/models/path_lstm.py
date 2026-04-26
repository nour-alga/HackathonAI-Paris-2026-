"""Path Predictor LSTM trained on real hack data to predict next destination."""
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
import networkx as nx
import os
from pathlib import Path

ENTITY_TYPES = {'unknown': 0, 'tornado_cash': 1, 'bridge_crosschain': 2, 'depot_cex': 3, 'mixer': 1, 'exchange': 3}
REVERSE_TYPES = {v: k for k, v in ENTITY_TYPES.items()}

class PathLSTM(nn.Module):
    def __init__(self, input_size=8, hidden_size=64, num_layers=2, output_size=4):
        super().__init__()
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True, dropout=0.2)
        self.fc1 = nn.Linear(hidden_size, 32)
        self.fc2 = nn.Linear(32, output_size)
        self.relu = nn.ReLU()

    def forward(self, x):
        lstm_out, _ = self.lstm(x)
        return self.fc2(self.relu(self.fc1(lstm_out[:, -1, :])))

def build_wallet_sequences(df, min_len=2, max_len=5):
    sequences, labels = [], []
    for sender, group in df.groupby('from_address'):
        if len(group) < min_len:
            continue
        group = group.sort_values('block_timestamp')
        recipients = group['to_address'].values
        categories = group['to_category'].fillna('unknown').values
        for i in range(len(recipients) - 1):
            seq = recipients[max(0, i - max_len + 2):i + 1]
            sequences.append((list(seq), recipients[i+1], categories[i+1]))
            labels.append(ENTITY_TYPES.get(categories[i+1], 0))
    return sequences, labels

def get_graph_features(address, graph, cache: dict | None = None):
    """Features par adresse. Si `cache` fourni, on prend pagerank/clustering en O(1)
    au lieu de les recalculer sur tout le graphe à chaque appel (catastrophique en training)."""
    if address not in graph:
        return np.array([0.0]*8, dtype=np.float32)
    in_deg = min(graph.in_degree(address) / 100, 1.0) or 0
    out_deg = min(graph.out_degree(address) / 100, 1.0) or 0
    taint = graph.nodes[address].get('taint_score', 0.5)
    if cache is not None:
        clustering = cache["clustering"].get(address, 0.0)
        pagerank = min(cache["pagerank"].get(address, 0.001) * 1000, 1.0)
    else:
        try:
            clustering = nx.local_clustering_coefficient(graph.to_undirected(), address)
        except Exception:
            clustering = 0.0
        try:
            pagerank = min(nx.pagerank(graph).get(address, 0.001) * 1000, 1.0)
        except Exception:
            pagerank = 0.001
    is_mixer = 1.0 if 'tornado' in str(address).lower() else 0.0
    is_bridge = 1.0 if 'bridge' in str(address).lower() else 0.0
    return np.array([in_deg, out_deg, taint, clustering, pagerank, is_mixer, is_bridge, 0.0], dtype=np.float32)


def _build_feature_cache(graph: "nx.DiGraph") -> dict:
    print("[PathLSTM] Pre-computing pagerank...")
    try:
        pr = nx.pagerank(graph, max_iter=50, tol=1e-4)
    except Exception:
        pr = {}
    print("[PathLSTM] Pre-computing clustering...")
    try:
        cl = nx.clustering(graph.to_undirected())
    except Exception:
        cl = {}
    return {"pagerank": pr, "clustering": cl}

def train_path_lstm(dataset='salam_ammari_dataset/Dataset/Dataset.csv', model_path='backend/models/path_lstm.pt', epochs=8, batch_size=32):
    print("[PathLSTM] Loading dataset...")
    df = pd.read_csv(dataset)
    df = df.dropna(subset=['from_address', 'to_address'])
    print(f"[PathLSTM] Extracting sequences from {len(df)} txs...")
    sequences, labels = build_wallet_sequences(df)
    print(f"[PathLSTM] Generated {len(sequences)} sequences")
    if len(sequences) < 100:
        print("[PathLSTM] Not enough sequences")
        return None
    print("[PathLSTM] Building graph...")
    G = nx.DiGraph()
    for _, row in df.iterrows():
        G.add_edge(row['from_address'], row['to_address'])
        if row['to_address'] not in G.nodes:
            G.nodes[row['to_address']]['taint_score'] = float(row['to_scam'])
    print(f"[PathLSTM] Graph: {G.number_of_nodes()} wallets, {G.number_of_edges()} edges")
    cache = _build_feature_cache(G)
    print("[PathLSTM] Converting to tensors...")
    X, y = [], []
    for seq, _, cat in sequences:
        seq = seq[-5:] if len(seq) > 5 else seq + [seq[-1]]*(5-len(seq))
        feats = [get_graph_features(a, G, cache) for a in seq]
        X.append(np.array(feats))
        y.append(ENTITY_TYPES.get(cat, 0))
    X, y = np.array(X, dtype=np.float32), np.array(y, dtype=np.int64)
    split = int(0.8 * len(X))
    X_train, y_train = X[:split], y[:split]
    loader = DataLoader(TensorDataset(torch.from_numpy(X_train), torch.from_numpy(y_train)), batch_size=batch_size, shuffle=True)
    model = PathLSTM().cpu()
    opt = torch.optim.Adam(model.parameters(), lr=0.001)
    loss_fn = nn.CrossEntropyLoss()
    print("[PathLSTM] Training...")
    for ep in range(epochs):
        for X_b, y_b in loader:
            opt.zero_grad()
            loss = loss_fn(model(X_b), y_b)
            loss.backward()
            opt.step()
        if (ep+1) % max(1, epochs//3) == 0:
            print(f"  Epoch {ep+1}/{epochs}")
    Path(model_path).parent.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), model_path)
    print(f"[PathLSTM] Saved to {model_path}")
    return model

def load_path_lstm(path='backend/models/path_lstm.pt'):
    model = PathLSTM().cpu()
    if os.path.exists(path):
        model.load_state_dict(torch.load(path, map_location='cpu'))
    model.eval()
    return model

def predict_next(addresses, graph, model=None):
    if model is None:
        model = load_path_lstm()
    feats = [get_graph_features(a, graph) for a in addresses[-5:]]
    while len(feats) < 5:
        feats.insert(0, feats[0])
    X = torch.from_numpy(np.array(feats[:5], dtype=np.float32)).unsqueeze(0)
    with torch.no_grad():
        logits = model(X)
        probs = torch.softmax(logits, dim=1)[0]
        pred = logits.argmax(dim=1).item()
    return {'destination_type': REVERSE_TYPES.get(pred, 'unknown'), 'confidence': float(probs[pred]), 'probabilities': {REVERSE_TYPES.get(i, 'unknown'): float(p) for i, p in enumerate(probs)}}

if __name__ == "__main__":
    train_path_lstm()
    print("Done!")
