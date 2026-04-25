"""
Entraînement du LSTM sur des séquences de mouvements de hackers.

Les séquences sont construites à partir des hacks historiques connus
+ augmentation de données pour enrichir le dataset.

Usage :
  python -m backend.models.lstm.train
"""
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from .model import DestinationLSTM, MOVE_TYPES, NUM_CLASSES

OUTPUT_PATH = "backend/data/training/lstm_model.pt"

# Séquences réelles extraites des hacks historiques majeurs
# Format : (séquence_observée, prochaine_destination)
HACK_SEQUENCES = [
    # Euler Finance — mars 2023 — $197M
    (["vol_initial"], "split_wallets"),
    (["vol_initial", "split_wallets"], "peel_chain"),
    (["vol_initial", "split_wallets", "peel_chain"], "tornado_cash"),

    # Ronin Bridge — mars 2022 — $625M
    (["vol_initial"], "split_wallets"),
    (["vol_initial", "split_wallets"], "bridge_crosschain"),
    (["vol_initial", "split_wallets", "bridge_crosschain"], "depot_cex"),

    # Wormhole — février 2022 — $320M
    (["vol_initial"], "split_wallets"),
    (["vol_initial", "split_wallets"], "peel_chain"),
    (["vol_initial", "split_wallets", "peel_chain"], "bridge_crosschain"),
    (["vol_initial", "split_wallets", "peel_chain", "bridge_crosschain"], "tornado_cash"),

    # Nomad Bridge — août 2022 — $190M
    (["vol_initial"], "split_wallets"),
    (["vol_initial", "split_wallets"], "peel_chain"),
    (["vol_initial", "split_wallets", "peel_chain"], "tornado_cash"),

    # Beanstalk — avril 2022 — $182M
    (["vol_initial"], "consolidation"),
    (["vol_initial", "consolidation"], "depot_cex"),

    # Harmony Horizon — juin 2022 — $100M
    (["vol_initial"], "split_wallets"),
    (["vol_initial", "split_wallets"], "bridge_crosschain"),
    (["vol_initial", "split_wallets", "bridge_crosschain"], "tornado_cash"),

    # Mango Markets — octobre 2022 — $117M
    (["vol_initial"], "consolidation"),
    (["vol_initial", "consolidation"], "split_wallets"),
    (["vol_initial", "consolidation", "split_wallets"], "depot_cex"),

    # Wintermute — septembre 2022 — $160M
    (["vol_initial"], "split_wallets"),
    (["vol_initial", "split_wallets"], "consolidation"),
    (["vol_initial", "split_wallets", "consolidation"], "tornado_cash"),

    # Patterns génériques observés en forensics
    (["vol_initial", "split_wallets", "peel_chain", "consolidation"], "tornado_cash"),
    (["vol_initial", "split_wallets", "peel_chain", "consolidation"], "bridge_crosschain"),
    (["vol_initial", "split_wallets", "consolidation", "peel_chain"], "tornado_cash"),
    (["vol_initial", "bridge_crosschain"], "depot_cex"),
    (["vol_initial", "bridge_crosschain"], "tornado_cash"),
    (["vol_initial", "peel_chain"], "tornado_cash"),
    (["vol_initial", "peel_chain", "consolidation"], "depot_cex"),
]


def augment_sequences(sequences: list, n_augment: int = 5) -> list:
    """
    Augmentation légère : décale les sous-séquences pour multiplier les exemples.
    Ex: [A, B, C] → [A, B, C], [B, C] avec même target.
    """
    augmented = list(sequences)
    for seq, target in sequences:
        for start in range(1, len(seq)):
            sub = seq[start:]
            if sub:
                augmented.append((sub, target))
    return augmented


class HackSequenceDataset(Dataset):
    def __init__(self, sequences: list, max_len: int = 8):
        self.samples = []
        self.max_len = max_len

        for seq, target in sequences:
            ids = [MOVE_TYPES.get(m, 0) for m in seq]
            # Padding à gauche
            padded = [0] * (max_len - len(ids)) + ids
            padded = padded[-max_len:]
            label = MOVE_TYPES.get(target, 0)
            self.samples.append((padded, label))

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        seq, label = self.samples[idx]
        return torch.tensor(seq, dtype=torch.long), torch.tensor(label, dtype=torch.long)


def train():
    sequences = augment_sequences(HACK_SEQUENCES)
    print(f"Dataset : {len(sequences)} séquences après augmentation")

    dataset = HackSequenceDataset(sequences)
    loader = DataLoader(dataset, batch_size=8, shuffle=True)

    model = DestinationLSTM(hidden_dim=64, num_layers=2)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    criterion = nn.CrossEntropyLoss()

    print("Entraînement LSTM...")
    for epoch in range(300):
        model.train()
        total_loss = 0.0
        correct = 0
        total = 0

        for seqs, labels in loader:
            optimizer.zero_grad()
            logits = model(seqs)
            loss = criterion(logits, labels)
            loss.backward()
            optimizer.step()

            total_loss += loss.item()
            preds = logits.argmax(dim=-1)
            correct += (preds == labels).sum().item()
            total += labels.size(0)

        if epoch % 50 == 0:
            acc = correct / total
            print(f"Epoch {epoch:3d} | Loss {total_loss/len(loader):.4f} | Acc {acc:.3f}")

    torch.save(model.state_dict(), OUTPUT_PATH)
    print(f"Modèle LSTM sauvegardé : {OUTPUT_PATH}")
    return model


if __name__ == "__main__":
    train()
