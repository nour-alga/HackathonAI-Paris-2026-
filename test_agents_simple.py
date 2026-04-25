"""Test simple des agents sans dépendances Supabase."""
import asyncio
import json
import os
from dotenv import load_dotenv

load_dotenv(".env")

from backend.agents.taint_agent import analyze_taint
from backend.agents.path_agent import predict_path
from backend.agents.reporter_agent import generate_report

# Test 1: TaintAnalyst
print("=" * 60)
print("TEST 1: TaintAnalyst Agent")
print("=" * 60)

wallets = [
    {
        "address": "0x1234567890abcdef1234567890abcdef12345678",
        "amount_eth": 10.5,
        "hops": 1,
        "entity_type": "unknown",
    },
    {
        "address": "0x722122df12d4e14e13ac3b6895a86e84145b6967",
        "amount_eth": 5.0,
        "hops": 2,
        "entity_type": "tornado_cash",
    },
]

try:
    taint_result = analyze_taint(
        wallets=wallets,
        source_address="0xhacker",
        amount_eth=100.0,
    )
    print(f"OK TaintAnalyst returned:\n{json.dumps(taint_result, indent=2)[:500]}")
except Exception as e:
    print(f"ERROR TaintAnalyst error: {e}")

# Test 2: PathPredictor
print("\n" + "=" * 60)
print("TEST 2: PathPredictor Agent")
print("=" * 60)

try:
    path_result = predict_path(
        tainted_count=5,
        max_taint_score=0.85,
        move_sequence=["vol_initial", "split_wallets"],
        amount_eth=100.0,
        protocol="Euler Finance",
    )
    print(f"OK PathPredictor returned:\n{json.dumps(path_result, indent=2)}")
except Exception as e:
    print(f"ERROR PathPredictor error: {e}")

# Test 3: IncidentReporter
print("\n" + "=" * 60)
print("TEST 3: IncidentReporter Agent")
print("=" * 60)

try:
    report = generate_report(
        taint_analysis=taint_result if 'taint_result' in locals() else {},
        path_prediction=path_result if 'path_result' in locals() else {},
        hack_context={
            "protocol": "Euler Finance",
            "amount_usd": 320000,
            "minutes_elapsed": 5,
            "tainted_count": 5,
        },
    )
    print(f"OK IncidentReporter returned:\n{report[:500]}")
except Exception as e:
    print(f"ERROR IncidentReporter error: {e}")

print("\n" + "=" * 60)
print("All agent tests completed!")
print("=" * 60)
