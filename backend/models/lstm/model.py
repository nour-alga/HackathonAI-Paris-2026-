"""
LSTM Destination Predictor — prédit la prochaine étape du hacker.

Mouvement types encodés :
  0 = vol_initial
  1 = split_wallets
  2 = peel_chain
  3 = consolidation
  4 = tornado_cash
  5 = bridge_crosschain
  6 = depot_cex
"""
import torch
import torch.nn as nn

MOVE_TYPES = {
    "vol_initial": 0,
    "split_wallets": 1,
    "peel_chain": 2,
    "consolidation": 3,
    "tornado_cash": 4,
    "bridge_crosschain": 5,
    "depot_cex": 6,
}

NUM_CLASSES = len(MOVE_TYPES)


class DestinationLSTM(nn.Module):
    """
    Input  : séquence de mouvements passés (encoded as ints)
    Output : distribution de probabilité sur la prochaine destination
    """

    def __init__(self, hidden_dim: int = 64, num_layers: int = 2):
        super().__init__()
        self.embedding = nn.Embedding(NUM_CLASSES, 16)
        self.lstm = nn.LSTM(
            input_size=16,
            hidden_size=hidden_dim,
            num_layers=num_layers,
            batch_first=True,
            dropout=0.3,
        )
        self.classifier = nn.Linear(hidden_dim, NUM_CLASSES)

    def forward(self, x):
        # x : (batch, seq_len) — séquence de move_ids
        embedded = self.embedding(x)
        out, _ = self.lstm(embedded)
        last = out[:, -1, :]  # dernier état caché
        return self.classifier(last)
