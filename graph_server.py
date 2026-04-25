"""
KOVER.IA Graph Visualization Server — stdlib HTTP server (no FastAPI needed)
Serves interactive graph UI with real-time alerts and manual pipeline triggering
"""
import http.server
import socketserver
import json
import csv
import random
import os
from pathlib import Path
from collections import defaultdict, deque
from datetime import datetime
from urllib.parse import urlparse, parse_qs

PORT = 5000
BASE_DIR = Path(__file__).parent
CSV_PATH = BASE_DIR / 'salam_ammari_dataset' / 'Dataset' / 'Dataset.csv'

class GraphHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.serve_file('graph_app.html', 'text/html')
        elif self.path == '/api/transactions':
            self.handle_transactions()
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == '/api/pipeline':
            self.handle_pipeline()
        else:
            self.send_error(404)

    def generate_synthetic_transactions(self):
        """Generate proper connected chains — each node is reused across steps (carry-forward pattern)"""
        transactions = []
        tx_id = 0
        all_chains = []  # list of [node0, node1, node2, ...] for each chain

        def make_tx(from_addr, to_addr, is_scam=0):
            nonlocal tx_id
            t = {
                'from_address': from_addr,
                'to_address': to_addr,
                'hash': f'0x{tx_id:064x}',
                'value': str(int(random.uniform(0.5, 30.0) * 1e18)),
                'block_timestamp': '2024-01-01',
                'block_number': 1000 + tx_id,
                'from_scam': is_scam,
                'to_scam': 0,
                'to_category': 'unknown'
            }
            tx_id += 1
            return t

        # 6-9 clean chains: generate all nodes first, then connect sequentially
        num_clean_chains = random.randint(6, 9)
        for c in range(num_clean_chains):
            chain_len = random.randint(4, 6)
            # Generate the full list of node addresses for this chain
            nodes = [f"0xw{c}n{i}{''.join(random.choices('0123456789abcdef', k=6))}" for i in range(chain_len)]
            all_chains.append(nodes)
            # Connect them in sequence: nodes[0] -> nodes[1] -> ... -> nodes[chain_len-1]
            for i in range(len(nodes) - 1):
                transactions.append(make_tx(nodes[i], nodes[i + 1]))

        # 1-2 hack chains: same carry-forward pattern, first tx marked as scam
        num_hacks = random.randint(1, 2)
        for h in range(num_hacks):
            hack_len = random.randint(3, 5)
            nodes = [f"0xhk{h}n{i}{''.join(random.choices('0123456789abcdef', k=6))}" for i in range(hack_len)]
            all_chains.append(nodes)
            for i in range(len(nodes) - 1):
                transactions.append(make_tx(nodes[i], nodes[i + 1], is_scam=1 if i == 0 else 0))

        # A few cross-connections between chains for graph richness (optional branching)
        flat_nodes = [n for chain in all_chains for n in chain]
        for _ in range(min(8, len(flat_nodes) // 4)):
            src = random.choice(flat_nodes[:-1])
            dst = random.choice(flat_nodes[1:])
            if src != dst:
                transactions.append(make_tx(src, dst))

        return transactions

    def handle_transactions(self):
        """Generate synthetic transactions with 2-3 hack chains, compute taint scores via BFS, return graph JSON"""
        try:
            # Generate synthetic transactions (100 total, with 2-3 hack chains)
            sample = self.generate_synthetic_transactions()

            # Build graph: nodes = unique addresses, edges = transactions
            nodes_dict = {}
            edges = []
            from_addresses = defaultdict(float)
            tx_count = defaultdict(int)

            for tx in sample:
                from_addr = tx.get('from_address', '')
                to_addr = tx.get('to_address', '')
                tx_hash = tx.get('hash', '')
                try:
                    amount_wei = float(tx.get('value', 0))
                    amount_eth = amount_wei / 1e18
                except:
                    amount_eth = 0.0

                if not from_addr or not to_addr:
                    continue

                # Initialize nodes
                for addr in [from_addr, to_addr]:
                    if addr not in nodes_dict:
                        nodes_dict[addr] = {
                            'id': addr,
                            'label': addr[:8] + '...' + addr[-4:],
                            'from_scam': int(tx.get('from_scam', 0)) if addr == from_addr else 0,
                            'to_scam': int(tx.get('to_scam', 0)) if addr == to_addr else 0,
                            'total_eth': 0.0,
                            'tx_count': 0,
                            'entity_type': tx.get('to_category', 'unknown') if addr == to_addr else 'unknown'
                        }

                # Accumulate amounts and tx count
                if from_addr in nodes_dict:
                    nodes_dict[from_addr]['total_eth'] += amount_eth
                    nodes_dict[from_addr]['tx_count'] += 1
                if to_addr in nodes_dict:
                    nodes_dict[to_addr]['total_eth'] += amount_eth

                # Add edge
                edges.append({
                    'id': f'tx_{tx_hash[:16]}',
                    'source': from_addr,
                    'target': to_addr,
                    'amount_eth': amount_eth,
                    'tx_hash': tx_hash,
                    'timestamp': tx.get('block_timestamp', '')
                })

            # BFS distance-based taint propagation
            # Taint score = 1.0 / (1 + hops_from_source)
            # Seed: nodes where from_scam=1 are hops=0
            hops_from_source = defaultdict(lambda: float('inf'))
            fraud_sources = [addr for addr, node in nodes_dict.items() if node['from_scam'] == 1]

            for source in fraud_sources:
                hops_from_source[source] = 0

            # BFS from fraud sources (distance-based, not amount-based)
            visited = set()
            queue = deque(fraud_sources)

            while queue:
                current = queue.popleft()
                if current in visited:
                    continue
                visited.add(current)

                current_hops = hops_from_source[current]

                # Find outgoing edges
                for edge in edges:
                    if edge['source'] == current:
                        target = edge['target']
                        if target not in visited:
                            new_hops = current_hops + 1
                            if new_hops < hops_from_source[target]:
                                hops_from_source[target] = new_hops
                                queue.append(target)

            # Assign taint scores based on distance (very slow decay for better distribution)
            taint_scores = {}
            for addr in nodes_dict.keys():
                hops = hops_from_source[addr]
                if hops == float('inf'):
                    taint_scores[addr] = 0.0  # Not reachable from fraud source
                else:
                    # Very slow decay: 1.0 / (1 + 0.15*hops)
                    # Hops 0: 1.0, Hops 1: 0.87, Hops 2: 0.77, Hops 3: 0.69, Hops 4: 0.63, Hops 5: 0.57, Hops 6: 0.53, Hops 7: 0.49
                    taint_scores[addr] = 1.0 / (1.0 + 0.15 * hops)

            # Assign taint scores to nodes
            for addr, node in nodes_dict.items():
                node['taint_score'] = taint_scores.get(addr, 0.0)

            # Count alerts (simplified: CRITICAL or CLEAN only)
            critical_count = sum(1 for node in nodes_dict.values() if node['taint_score'] > 0.75)
            clean_count = sum(1 for node in nodes_dict.values() if node['taint_score'] <= 0.75)

            # Return graph
            response = {
                'nodes': list(nodes_dict.values()),
                'edges': edges,
                'stats': {
                    'total_nodes': len(nodes_dict),
                    'total_edges': len(edges),
                    'critical_count': critical_count,
                    'clean_count': clean_count
                }
            }
            self.send_json(response)

        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def handle_pipeline(self):
        """Mock pipeline endpoint — returns incident report"""
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8')
            data = json.loads(body)

            address = data.get('address', '0x...')
            amount_eth = data.get('amount_eth', 0.0)

            # Mock pipeline result
            response = {
                'severity': 'CRITICAL' if amount_eth > 10 else 'HIGH' if amount_eth > 1 else 'MEDIUM',
                'summary': f'Potential fraud detected at {address} ({amount_eth:.2f} ETH)',
                'narrative': f"""INCIDENT REPORT — POTENTIAL FRAUD DETECTED

EXECUTIVE SUMMARY:
Suspected fraudulent activity detected for wallet {address} involving {amount_eth:.2f} ETH.
System recommends immediate investigation and monitoring.

TECHNICAL ANALYSIS:
Wallet taint score: {min(0.95, amount_eth/100):.2f}
Transaction count: ~5
Entity type: Unknown

RECOMMENDED ACTIONS:
1. Monitor wallet for further suspicious activity
2. Cross-reference with known fraud patterns
3. Consider adding to watchlist for future transactions
4. Coordinate with liquidity providers

CONFIDENCE: 85% based on propagated taint analysis""",
                'path_prediction': {
                    'next_destination': 'Tornado Cash Mixer' if amount_eth > 5 else 'CEX Deposit',
                    'probability': 0.85,
                    'eta_minutes': 15
                }
            }
            self.send_json(response)

        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def serve_file(self, filename, content_type):
        """Serve a local file"""
        file_path = BASE_DIR / filename
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(content.encode('utf-8'))
        except FileNotFoundError:
            self.send_error(404)

    def send_json(self, data, status=200):
        """Send JSON response"""
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def options(self):
        """Handle CORS preflight"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_OPTIONS(self):
        self.options()


if __name__ == '__main__':
    handler = GraphHandler
    with socketserver.TCPServer(("", PORT), handler) as httpd:
        print(f"\n{'='*60}")
        print(f"KOVER.IA Graph Visualization Server")
        print(f"{'='*60}")
        print(f"Running on http://127.0.0.1:{PORT}")
        print(f"Press Ctrl+C to stop")
        print(f"{'='*60}\n")
        httpd.serve_forever()
