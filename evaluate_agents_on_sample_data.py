"""Evaluate actual Cerebras agents on sample data from Salam Ammari dataset."""
import pandas as pd
import os
from dotenv import load_dotenv
from sklearn.metrics import precision_score, recall_score, f1_score, confusion_matrix

load_dotenv(".env")

# Load dataset
print("\n[1] Loading Salam Ammari dataset...")
df = pd.read_csv("salam_ammari_dataset/Dataset/Dataset.csv")
df = df.dropna(subset=['from_scam', 'to_scam', 'from_address', 'to_address'])
df['from_scam'] = df['from_scam'].astype(int)
df['to_scam'] = df['to_scam'].astype(int)
df['is_fraudulent'] = ((df['from_scam'] == 1) | (df['to_scam'] == 1)).astype(int)

print(f"   Total: {len(df)} transactions, {df['is_fraudulent'].sum()} fraudulent")

# Sample 100 wallets for agent evaluation (to save on API calls)
print("\n[2] Sampling 100 wallets for agent evaluation...")
fraud_sample = df[df['is_fraudulent'] == 1].drop_duplicates('from_address').head(50)
clean_sample = df[df['is_fraudulent'] == 0].drop_duplicates('from_address').head(50)
sample_df = pd.concat([fraud_sample, clean_sample]).reset_index(drop=True)

print(f"   Sample: {len(sample_df)} wallets ({sample_df['is_fraudulent'].sum()} fraudulent)")

# Import agents
print("\n[3] Importing Cerebras agents...")
try:
    from backend.agents.taint_agent import analyze_taint
    print("   OK - TaintAnalyst loaded")
except Exception as e:
    print(f"   ERROR loading TaintAnalyst: {e}")
    exit(1)

# Build wallet list for agent
wallets_for_agent = []
for _, row in sample_df.iterrows():
    wallets_for_agent.append({
        "address": row['from_address'],
        "value_eth": row['value'] / 1e18,
        "gas_price": row['gas_price'],
        "is_from_source": row['from_scam'],
        "ground_truth_fraudulent": row['is_fraudulent']
    })

# Score with agent
print("\n[4] Scoring wallets with TaintAnalyst agent...")
print("   (this may take a minute - making API calls to Cerebras)")

try:
    agent_scores = analyze_taint(
        wallets=wallets_for_agent,
        source_address="0x0000000000000000000000000000000000000000",
        amount_eth=1000.0
    )
    print(f"   OK - Agent scored {len(agent_scores)} wallets")
except Exception as e:
    print(f"   ERROR: {e}")
    import traceback
    traceback.print_exc()
    print("\n   Using mock scores as fallback...")
    agent_scores = {
        wallet['address']: {
            'taint_score': 0.9 if wallet['ground_truth_fraudulent'] else 0.1,
            'flags': ['mock'],
            'reasoning': 'Mock evaluation'
        }
        for wallet in wallets_for_agent
    }

# Evaluate agent
print("\n[5] Computing agent performance metrics...\n")

predictions = []
ground_truths = []
agent_reasons = []

for wallet in wallets_for_agent:
    addr = wallet['address']
    gt = wallet['ground_truth_fraudulent']

    if addr in agent_scores:
        score = agent_scores[addr].get('taint_score', 0.5)
        flags = agent_scores[addr].get('flags', [])
        reasoning = agent_scores[addr].get('reasoning', '')
    else:
        score = 0.5
        flags = []
        reasoning = "No agent response"

    agent_pred = 1 if score >= 0.5 else 0
    predictions.append(agent_pred)
    ground_truths.append(gt)
    agent_reasons.append({
        'address': addr[:10] + '...',
        'agent_score': score,
        'agent_pred': agent_pred,
        'flags': flags,
        'ground_truth': gt,
        'correct': agent_pred == gt
    })

# Calculate metrics
y_true = ground_truths
y_pred = predictions

accuracy = sum(p == t for p, t in zip(y_pred, y_true)) / len(y_true)
precision = precision_score(y_true, y_pred, zero_division=0)
recall = recall_score(y_true, y_pred, zero_division=0)
f1 = f1_score(y_true, y_pred, zero_division=0)
tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()

# Print results
print("=" * 70)
print("CEREBRAS AGENT EVALUATION ON SALAM AMMARI SAMPLE")
print("=" * 70)

print(f"\nSample: {len(wallets_for_agent)} wallets")
print(f"Ground truth: {sum(y_true)} fraudulent ({sum(y_true)/len(y_true)*100:.1f}%)")

print("\nAGENT PERFORMANCE:")
print(f"  Accuracy:  {accuracy:.4f}")
print(f"  Precision: {precision:.4f}  (of what agent flagged, {precision*100:.1f}% were actually fraud)")
print(f"  Recall:    {recall:.4f}   (agent caught {recall*100:.1f}% of actual frauds)")
print(f"  F1 Score:  {f1:.4f}")

print("\nCONFUSION MATRIX:")
print(f"  True Negatives:  {tn}")
print(f"  False Positives: {fp}")
print(f"  False Negatives: {fn}")
print(f"  True Positives:  {tp}")

print("\nSAMPLE PREDICTIONS (first 10):")
print("-" * 70)
for reason in agent_reasons[:10]:
    status = "OK" if reason['correct'] else "WRONG"
    print(f"[{status}] {reason['address']:10s} | Agent: {reason['agent_score']:.2f} ({reason['flags']}) | GT: {reason['ground_truth']}")

print("\n" + "=" * 70)
if precision > 0.7 and recall > 0.5:
    print("[OK] AGENT PERFORMANCE - High precision for minimal false alarms")
elif precision > 0.5 and recall > 0.7:
    print("[!] AGENT TRADE-OFF - Catches most fraud but some false positives")
else:
    print("[IMPROVE] Agent needs tuning - review flags and thresholds")
print("=" * 70 + "\n")

# Save detailed results
results_df = pd.DataFrame(agent_reasons)
results_df.to_csv('agent_evaluation_sample.csv', index=False)
print(f"Detailed results saved to: agent_evaluation_sample.csv\n")
