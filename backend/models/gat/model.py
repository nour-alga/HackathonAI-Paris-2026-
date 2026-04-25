"""
Graph Attention Network (GAT) pour la détection de blanchiment.

Architecture :
  - Input  : graphe de wallets (nœuds) et transactions (arêtes)
  - Output : score de risque 0→1 par nœud
  - Base   : Elliptic Dataset (200k txs labellisées Bitcoin) + hacks Ethereum BigQuery
"""
import torch
import torch.nn.functional as F
from torch_geometric.nn import GATConv


class TaintGAT(torch.nn.Module):
    """
    3 couches d'attention.
    node_features : nb de features par nœud (défini dans preprocessing)
    hidden_dim    : dimension des embeddings intermédiaires
    heads         : nb de têtes d'attention (multi-head attention)
    """

    def __init__(self, node_features: int = 10, hidden_dim: int = 64, heads: int = 4):
        super().__init__()

        self.conv1 = GATConv(node_features, hidden_dim, heads=heads, dropout=0.3)
        self.conv2 = GATConv(hidden_dim * heads, hidden_dim, heads=heads, dropout=0.3)
        self.conv3 = GATConv(hidden_dim * heads, 1, heads=1, concat=False)

    def forward(self, x, edge_index):
        x = F.dropout(x, p=0.3, training=self.training)
        x = F.elu(self.conv1(x, edge_index))

        x = F.dropout(x, p=0.3, training=self.training)
        x = F.elu(self.conv2(x, edge_index))

        x = self.conv3(x, edge_index)
        return torch.sigmoid(x).squeeze()
