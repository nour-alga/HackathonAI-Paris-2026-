"""
Inférence GAT — score de risque pour chaque wallet d'un graphe.
"""
import os
import torch
import networkx as nx
from torch_geometric.utils import from_networkx
from .model import TaintGAT


_model = None


def load_model() -> TaintGAT:
    global _model
    if _model is None:
        _model = TaintGAT()
        path = os.getenv("GAT_MODEL_PATH", "backend/data/training/gat_model.pt")
        state = torch.load(path, map_location="cpu", weights_only=True)
        _model.load_state_dict(state)
        _model.eval()
    return _model


def score_graph(graph: nx.DiGraph) -> dict[str, float]:
    """
    Reçoit un graphe NetworkX de wallets/transactions.
    Retourne un dict {adresse: score_risque 0→1}.
    """
    model = load_model()
    data = from_networkx(graph)

    with torch.no_grad():
        scores = model(data.x.float(), data.edge_index)

    nodes = list(graph.nodes())
    return {nodes[i]: float(scores[i]) for i in range(len(nodes))}
