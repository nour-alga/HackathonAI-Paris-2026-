"""
Entraînement du GAT sur l'Elliptic Dataset.

Usage :
  python -m backend.models.gat.train

Le modèle entraîné est sauvegardé dans data/training/gat_model.pt
"""
import torch
import torch.nn.functional as F
from torch_geometric.loader import DataLoader
from .model import TaintGAT


def train(dataset, epochs: int = 100, lr: float = 0.005):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = TaintGAT().to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=5e-4)

    loader = DataLoader(dataset, batch_size=32, shuffle=True)

    for epoch in range(epochs):
        model.train()
        total_loss = 0

        for batch in loader:
            batch = batch.to(device)
            optimizer.zero_grad()
            out = model(batch.x, batch.edge_index)
            loss = F.binary_cross_entropy(out[batch.train_mask], batch.y[batch.train_mask])
            loss.backward()
            optimizer.step()
            total_loss += loss.item()

        if epoch % 10 == 0:
            print(f"Epoch {epoch:3d} | Loss: {total_loss / len(loader):.4f}")

    torch.save(model.state_dict(), "backend/data/training/gat_model.pt")
    print("Modèle sauvegardé : backend/data/training/gat_model.pt")
    return model
