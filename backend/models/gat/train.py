"""
Entraînement du GAT sur l'Elliptic Dataset.

Usage :
  python -m backend.models.gat.train
"""
import torch
import torch.nn.functional as F
from sklearn.metrics import f1_score, classification_report
from .model import TaintGAT

OUTPUT_PATH = "backend/data/training/gat_model.pt"
GRAPH_PATH = "backend/data/training/elliptic_graph.pt"


def evaluate(model, data, mask):
    model.eval()
    with torch.no_grad():
        out = model(data.x, data.edge_index)
        preds = (out[mask] > 0.5).long()
        labels = data.y[mask]
        valid = labels != -1
        if valid.sum() == 0:
            return 0.0, 0.0
        f1 = f1_score(labels[valid].cpu(), preds[valid].cpu(), zero_division=0)
        acc = (preds[valid] == labels[valid]).float().mean().item()
    return acc, f1


def train():
    print("Chargement du graphe Elliptic...")
    data = torch.load(GRAPH_PATH, weights_only=False)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device : {device}")

    node_features = data.x.size(1)
    model = TaintGAT(node_features=node_features).to(device)
    data = data.to(device)

    optimizer = torch.optim.Adam(model.parameters(), lr=0.005, weight_decay=5e-4)
    scheduler = torch.optim.lr_scheduler.StepLR(optimizer, step_size=50, gamma=0.5)

    # Poids de classe pour gérer le déséquilibre illicit/licit (~1:10)
    train_labels = data.y[data.train_mask]
    n_licit = (train_labels == 0).sum().float()
    n_illicit = (train_labels == 1).sum().float()
    pos_weight = torch.tensor([n_licit / (n_illicit + 1e-6)]).to(device)

    best_val_f1 = 0.0
    best_state = None

    print("Entraînement en cours...")
    for epoch in range(200):
        model.train()
        optimizer.zero_grad()

        out = model(data.x, data.edge_index)
        mask = data.train_mask & (data.y != -1)
        targets = data.y[mask].float()
        preds_train = out[mask]

        loss = F.binary_cross_entropy(
            preds_train, targets,
            weight=pos_weight.expand_as(targets)
        )
        loss.backward()
        optimizer.step()
        scheduler.step()

        if epoch % 20 == 0:
            val_acc, val_f1 = evaluate(model, data, data.val_mask)
            print(f"Epoch {epoch:3d} | Loss {loss.item():.4f} | Val Acc {val_acc:.3f} | Val F1 {val_f1:.3f}")

            if val_f1 > best_val_f1:
                best_val_f1 = val_f1
                best_state = {k: v.clone() for k, v in model.state_dict().items()}

    if best_state:
        model.load_state_dict(best_state)

    test_acc, test_f1 = evaluate(model, data, data.test_mask)
    print(f"\nTest final | Acc {test_acc:.3f} | F1 {test_f1:.3f}")

    model.eval()
    with torch.no_grad():
        out = model(data.x, data.edge_index)
        mask = data.test_mask & (data.y != -1)
        preds_final = (out[mask] > 0.5).long().cpu()
        labels_final = data.y[mask].cpu()
        print(classification_report(labels_final, preds_final, target_names=["licit", "illicit"]))

    torch.save(model.state_dict(), OUTPUT_PATH)
    print(f"Modèle sauvegardé : {OUTPUT_PATH}")
    return model


if __name__ == "__main__":
    train()
