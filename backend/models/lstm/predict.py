"""
Inférence LSTM — prédit la prochaine destination des fonds.
"""
import os
import torch
import torch.nn.functional as F
from .model import DestinationLSTM, MOVE_TYPES

_model: DestinationLSTM | None = None
_id_to_move = {v: k for k, v in MOVE_TYPES.items()}


def load_model() -> DestinationLSTM:
    global _model
    if _model is None:
        _model = DestinationLSTM()
        path = os.getenv("LSTM_MODEL_PATH", "backend/data/training/lstm_model.pt")
        state = torch.load(path, map_location="cpu", weights_only=True)
        _model.load_state_dict(state)
        _model.eval()
    return _model


def predict_next(sequence: list[str]) -> dict[str, float]:
    """
    sequence : liste de mouvements passés
               ex. ["vol_initial", "split_wallets", "peel_chain"]
    Retourne : {"tornado_cash": 0.72, "bridge_crosschain": 0.18, ...}
    """
    model = load_model()
    ids = [MOVE_TYPES[m] for m in sequence if m in MOVE_TYPES]
    tensor = torch.tensor([ids], dtype=torch.long)

    with torch.no_grad():
        logits = model(tensor)
        probs = F.softmax(logits, dim=-1).squeeze()

    return {_id_to_move[i]: round(float(probs[i]), 4) for i in range(len(probs))}
