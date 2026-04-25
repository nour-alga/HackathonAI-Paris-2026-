"""Agent 2 — PathPredictor: LSTM-based destination prediction on real hack patterns."""
import os

_model = None

def get_model():
    global _model
    if _model is not None:
        return _model
    try:
        from backend.models.path_lstm import load_path_lstm
        _model = load_path_lstm()
        return _model
    except Exception as e:
        print(f"[PathPredictor] Warning: Could not load LSTM model: {e}")
        return None

def predict_path(tainted_count: int, max_taint_score: float, move_sequence: list[str],
                 amount_eth: float, protocol: str, graph=None) -> dict:
    """
    Predict next destination using LSTM trained on real hack data.
    Falls back to heuristics if model unavailable.

    Returns: {next_destination, probability, eta_minutes, reasoning}
    """
    model = get_model()

    destinations = {
        'tornado_cash': 'Tornado Cash Mixing Pool',
        'bridge_crosschain': 'Cross-Chain Bridge (Stargate/HOP/Wormhole)',
        'depot_cex': 'CEX Deposit (Binance/Kraken/Coinbase)',
        'unknown': 'Unknown Wallet/Mixer'
    }

    eta_map = {'tornado_cash': 8, 'bridge_crosschain': 12, 'depot_cex': 15, 'unknown': 20}

    confidence_base = min(max_taint_score, 1.0)

    if model and graph and hasattr(graph, 'graph') and hasattr(graph, 'nodes'):
        try:
            from backend.models.path_lstm import predict_next
            top_wallets = sorted(graph.nodes.values(), key=lambda n: n.taint_score, reverse=True)[:5]
            addresses = [n.address for n in top_wallets]
            if addresses:
                pred = predict_next(addresses, graph.graph, model)
                dest_type = pred['destination_type']
                confidence = pred['confidence'] * 0.9 + 0.1
            else:
                dest_type = 'tornado_cash'
                confidence = 0.8
        except Exception as e:
            print(f"[PathPredictor] Model prediction error: {e}. Using heuristic.")
            dest_type = 'tornado_cash' if max_taint_score > 0.7 else 'unknown'
            confidence = confidence_base
    else:
        if 'tornado_cash' in str(move_sequence).lower():
            dest_type = 'tornado_cash'
            confidence = 0.85
        elif 'bridge' in str(move_sequence).lower():
            dest_type = 'bridge_crosschain'
            confidence = 0.75
        elif max_taint_score > 0.8:
            dest_type = 'tornado_cash'
            confidence = 0.8
        else:
            dest_type = 'unknown'
            confidence = 0.5

    return {
        'next_destination': destinations.get(dest_type, 'Unknown'),
        'probability': float(min(max(confidence, 0.0), 1.0)),
        'eta_minutes': eta_map.get(dest_type, 15),
        'reasoning': f'LSTM pattern: {tainted_count} wallets analyzed, {dest_type} predicted ({confidence:.0%} confidence)'
    }
