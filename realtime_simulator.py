"""Real-time transaction simulator - streams 100 txs/sec from Salam Ammari dataset, processes through trained Cerebras classifier."""
import asyncio
import pandas as pd
import json
from datetime import datetime
from dotenv import load_dotenv
import os
from cerebras.cloud.sdk import Cerebras
from collections import deque

load_dotenv(".env")

class RealtimeSimulator:
    def __init__(self, transactions_per_second=100):
        self.client = Cerebras(api_key=os.getenv("CEREBRAS_API_KEY"))
        self.tps = transactions_per_second
        self.df = pd.read_csv('salam_ammari_dataset/Dataset/Dataset.csv')
        self.df = self.df.dropna(subset=['from_address', 'to_address'])
        self.processed = 0
        self.frauds_detected = 0
        self.clean_detected = 0
        self.start_time = datetime.now()
        self.results_buffer = deque(maxlen=10)

    async def classify_tx(self, tx_row):
        """Send transaction to trained Cerebras classifier."""
        value_eth = float(tx_row['value']) / 1e18

        prompt = f"""You are a fraud detector trained on 2000 Ethereum transactions.
Classify if this is FRAUD or CLEAN.

Transaction: {tx_row['from_address'][:8]}..to {tx_row['to_address'][:8]}..., {value_eth:.4f} ETH, Gas: {float(tx_row['gas_price'])/1e9:.1f} Gwei
Category: {tx_row.get('to_category', 'unknown')}

Answer (FRAUD or CLEAN):"""

        response = self.client.chat.completions.create(
            model="qwen-3-235b-a22b-instruct-2507",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=10,
            temperature=0.1
        )

        prediction = response.choices[0].message.content.strip().upper()[:5]
        ground_truth = "FRAUD" if tx_row['from_scam'] == 1 else "CLEAN"

        return {
            'tx': f"{tx_row['from_address'][:6]}..to{tx_row['to_address'][:6]}",
            'prediction': prediction,
            'ground_truth': ground_truth,
            'value_eth': value_eth,
            'timestamp': datetime.now().isoformat(),
            'correct': prediction in ground_truth or ground_truth in prediction
        }

    async def run_simulation(self, duration_seconds=30, batch_size=10):
        """Simulate transaction stream for duration_seconds."""
        print(f"\n{'='*70}")
        print("REALTIME TRANSACTION SIMULATION")
        print(f"{'='*70}")
        print(f"Starting stream: {self.tps} tx/sec for {duration_seconds}s = {self.tps*duration_seconds} total txs")
        print(f"Using Cerebras fraud detector trained on 2000 labeled examples\n")

        self.start_time = datetime.now()
        tx_idx = 0
        batch_count = 0

        # Simulate transaction stream
        while (datetime.now() - self.start_time).total_seconds() < duration_seconds:
            batch = []

            # Fetch batch from dataset
            for _ in range(min(batch_size, self.tps // 10)):
                if tx_idx >= len(self.df):
                    tx_idx = 0  # Loop dataset

                tx_row = self.df.iloc[tx_idx]
                batch.append(tx_row)
                tx_idx += 1
                self.processed += 1

            # Classify batch in parallel
            print(f"[Batch {batch_count+1}] Processing {len(batch)} transactions...", end=" ", flush=True)
            tasks = [self.classify_tx(tx) for tx in batch]
            results = await asyncio.gather(*tasks)

            # Update stats
            batch_frauds = sum(1 for r in results if r['prediction'] == 'FRAUD')
            batch_clean = sum(1 for r in results if r['prediction'] == 'CLEAN')
            batch_accuracy = sum(1 for r in results if r['correct']) / len(results) * 100

            self.frauds_detected += batch_frauds
            self.clean_detected += batch_clean

            # Store recent results
            for r in results:
                self.results_buffer.append(r)

            print(f"Frauds: {batch_frauds}, Clean: {batch_clean}, Accuracy: {batch_accuracy:.0f}%")
            batch_count += 1

            # Sleep to maintain rate
            await asyncio.sleep(1.0)  # Process batch every second

        return self.get_summary()

    def get_summary(self):
        """Return simulation summary."""
        elapsed = (datetime.now() - self.start_time).total_seconds()
        actual_tps = self.processed / elapsed if elapsed > 0 else 0

        summary = {
            'total_transactions': self.processed,
            'frauds_detected': self.frauds_detected,
            'clean_detected': self.clean_detected,
            'duration_seconds': elapsed,
            'actual_tps': actual_tps,
            'fraud_rate': self.frauds_detected / self.processed * 100 if self.processed > 0 else 0,
            'latest_results': list(self.results_buffer),
            'timestamp': datetime.now().isoformat()
        }
        return summary

async def main():
    simulator = RealtimeSimulator(transactions_per_second=100)
    summary = await simulator.run_simulation(duration_seconds=20, batch_size=10)

    print(f"\n{'='*70}")
    print("SIMULATION COMPLETE")
    print(f"{'='*70}")
    print(f"Total transactions processed: {summary['total_transactions']}")
    print(f"Frauds detected: {summary['frauds_detected']}")
    print(f"Clean transactions: {summary['clean_detected']}")
    print(f"Duration: {summary['duration_seconds']:.1f} seconds")
    print(f"Actual throughput: {summary['actual_tps']:.1f} tx/sec")
    print(f"Fraud rate in stream: {summary['fraud_rate']:.1f}%")

    print(f"\nLatest 5 transactions:")
    for r in summary['latest_results'][-5:]:
        mark = "OK" if r['correct'] else "WRONG"
        print(f"  [{mark}] {r['tx']}: {r['prediction']} (actual: {r['ground_truth']})")

    # Save results
    with open('simulation_results.json', 'w') as f:
        json.dump(summary, f, indent=2)
    print(f"\nResults saved to: simulation_results.json")

if __name__ == "__main__":
    asyncio.run(main())
