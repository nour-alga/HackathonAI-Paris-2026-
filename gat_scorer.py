"""
KOVER.IA - GAT fraud scorer
2-layer Graph Attention Network trained on the Salam Ammari dataset.

Node features (8):
  total_eth_sent, total_eth_received,
  tx_count_out, tx_count_in,
  out_degree, in_degree,
  avg_value_sent, avg_value_received

Label: 1 if wallet has from_scam=1 in any transaction, else 0
"""
import csv
import torch
import torch.nn.functional as F
from torch_geometric.nn import GATConv
from torch_geometric.data import Data
from collections import defaultdict
from pathlib import Path

CSV_PATH   = Path(__file__).parent / 'salam_ammari_dataset' / 'Dataset' / 'Dataset.csv'
MODEL_PATH = Path(__file__).parent / 'gat_model.pt'


def build_graph():
    print("Loading CSV...")
    with open(CSV_PATH, 'r', encoding='utf-8', errors='ignore') as f:
        rows = list(csv.DictReader(f))
    print(f"  {len(rows)} transactions")

    addr_set = set()
    for r in rows:
        if r.get('from_address') and r.get('to_address'):
            addr_set.add(r['from_address'])
            addr_set.add(r['to_address'])

    addr_to_idx = {a: i for i, a in enumerate(sorted(addr_set))}
    n = len(addr_to_idx)
    print(f"  {n} unique wallets")

    eth_sent = defaultdict(float)
    eth_recv = defaultdict(float)
    tx_out   = defaultdict(int)
    tx_in    = defaultdict(int)
    dests    = defaultdict(set)
    sources  = defaultdict(set)
    fraud    = defaultdict(int)
    esrc, edst = [], []

    for r in rows:
        fr = r.get('from_address', '')
        to = r.get('to_address', '')
        if not fr or not to or fr not in addr_to_idx or to not in addr_to_idx:
            continue
        try:
            val = float(r.get('value', 0)) / 1e18
        except Exception:
            val = 0.0

        eth_sent[fr] += val
        eth_recv[to] += val
        tx_out[fr]   += 1
        tx_in[to]    += 1
        dests[fr].add(to)
        sources[to].add(fr)
        if int(r.get('from_scam', 0)) == 1:
            fraud[fr] = 1
        esrc.append(addr_to_idx[fr])
        edst.append(addr_to_idx[to])

    x = torch.zeros(n, 8)
    for addr, idx in addr_to_idx.items():
        s  = eth_sent[addr];  rc = eth_recv[addr]
        to = tx_out[addr];    ti = tx_in[addr]
        x[idx] = torch.tensor([
            s, rc, float(to), float(ti),
            float(len(dests[addr])), float(len(sources[addr])),
            s / to if to > 0 else 0.0,
            rc / ti if ti > 0 else 0.0,
        ])
    x = torch.log1p(x)  # log-scale: handles the huge ETH variance

    y = torch.zeros(n, dtype=torch.long)
    for addr, idx in addr_to_idx.items():
        y[idx] = fraud[addr]

    edge_index = torch.tensor([esrc, edst], dtype=torch.long)
    fc = int(y.sum())
    print(f"  Fraud nodes: {fc} / {n} ({100*fc/n:.1f}%)")
    return Data(x=x, edge_index=edge_index, y=y), addr_to_idx


class FraudGAT(torch.nn.Module):
    def __init__(self, in_channels=8, hidden=32, heads=4):
        super().__init__()
        self.gat1 = GATConv(in_channels, hidden, heads=heads, dropout=0.3)
        self.gat2 = GATConv(hidden * heads, hidden, heads=1, concat=False, dropout=0.3)
        self.out  = torch.nn.Linear(hidden, 2)

    def forward(self, x, edge_index):
        x = F.elu(self.gat1(x, edge_index))
        x = F.elu(self.gat2(x, edge_index))
        return self.out(x)


def train(epochs=80):
    data, addr_to_idx = build_graph()
    n = data.x.shape[0]

    perm = torch.randperm(n)
    train_mask = torch.zeros(n, dtype=torch.bool)
    val_mask   = torch.zeros(n, dtype=torch.bool)
    train_mask[perm[:int(n * 0.8)]] = True
    val_mask[perm[int(n * 0.8):]]   = True

    # Weight to handle class imbalance (96% clean, 4% fraud)
    fraud_n = int(data.y.sum())
    weight  = torch.tensor([1.0, (n - fraud_n) / max(fraud_n, 1)])

    model     = FraudGAT()
    optimizer = torch.optim.Adam(model.parameters(), lr=5e-3, weight_decay=1e-4)

    print(f"\nTraining GAT ({epochs} epochs)...")
    best_acc = 0.0

    for epoch in range(1, epochs + 1):
        model.train()
        optimizer.zero_grad()
        out  = model(data.x, data.edge_index)
        loss = F.cross_entropy(out[train_mask], data.y[train_mask], weight=weight)
        loss.backward()
        optimizer.step()

        if epoch % 10 == 0:
            model.eval()
            with torch.no_grad():
                pred = out.argmax(dim=1)
                val_acc = (pred[val_mask] == data.y[val_mask]).float().mean().item()
                fraud_mask = data.y[val_mask] == 1
                recall = (pred[val_mask][fraud_mask] == 1).float().mean().item() if fraud_mask.sum() > 0 else 0.0
            print(f"  Epoch {epoch:3d} | loss={loss:.4f} | val_acc={val_acc:.3f} | fraud_recall={recall:.3f}")
            if val_acc > best_acc:
                best_acc = val_acc
                torch.save(model.state_dict(), MODEL_PATH)

    print(f"\nBest val accuracy: {best_acc:.3f}")
    print(f"Model saved: {MODEL_PATH}")
    return model, addr_to_idx


def score_nodes(nodes_dict, edges):
    """Score nodes using the trained GAT. Returns {addr: fraud_probability}."""
    if not MODEL_PATH.exists():
        return {}

    addrs = list(nodes_dict.keys())
    a2i   = {a: i for i, a in enumerate(addrs)}
    n     = len(addrs)

    eth_sent = defaultdict(float)
    eth_recv = defaultdict(float)
    tx_out   = defaultdict(int)
    tx_in    = defaultdict(int)
    dests    = defaultdict(set)
    sources  = defaultdict(set)
    esrc, edst = [], []

    for e in edges:
        fr, to = e['source'], e['target']
        if fr not in a2i or to not in a2i:
            continue
        v = e.get('amount_eth', 0.0)
        eth_sent[fr] += v;  eth_recv[to] += v
        tx_out[fr]   += 1;  tx_in[to]    += 1
        dests[fr].add(to);  sources[to].add(fr)
        esrc.append(a2i[fr]); edst.append(a2i[to])

    x = torch.zeros(n, 8)
    for addr, idx in a2i.items():
        s  = eth_sent[addr];  rc = eth_recv[addr]
        to = tx_out[addr];    ti = tx_in[addr]
        x[idx] = torch.tensor([
            s, rc, float(to), float(ti),
            float(len(dests[addr])), float(len(sources[addr])),
            s / to if to > 0 else 0.0,
            rc / ti if ti > 0 else 0.0,
        ])
    x = torch.log1p(x)

    if not esrc:
        return {}

    edge_index = torch.tensor([esrc, edst], dtype=torch.long)
    model = FraudGAT()
    model.load_state_dict(torch.load(MODEL_PATH, map_location='cpu', weights_only=True))
    model.eval()
    with torch.no_grad():
        probs = F.softmax(model(x, edge_index), dim=1)[:, 1]

    return {addr: float(probs[a2i[addr]]) for addr in addrs}


if __name__ == '__main__':
    train(epochs=80)
