"""
Fine-tuning Cerebras (Llama/Qwen) sur training_data_cerebras.jsonl.

Note : à ce jour le SDK `cerebras.cloud.sdk` expose uniquement chat/completions
(inférence). On tente d'abord un appel REST direct vers un endpoint
fine-tuning hypothétique. Si l'API n'est pas dispo, on bascule sur la
préparation d'exemples few-shot que reporter_agent.py utilisera dans son
system prompt — c'est l'approche déjà documentée dans CEREBRAS_TRAINING_RESULTS.md
qui obtient 80% sur le held-out set.

Usage:
  CEREBRAS_API_KEY=... python scripts/cerebras_finetune.py [--mode finetune|fewshot|auto]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
JSONL_PATH = ROOT / "training_data_cerebras.jsonl"
FEWSHOT_OUT = ROOT / "backend" / "agents" / "few_shot_examples.json"
ENV_OUT = ROOT / ".env.fine_tuned"

CEREBRAS_API_BASE = os.getenv("CEREBRAS_API_BASE", "https://api.cerebras.ai/v1")
DEFAULT_BASE_MODEL = os.getenv("CEREBRAS_FT_BASE_MODEL", "llama3.1-8b")


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        raise FileNotFoundError(f"{path} introuvable")
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def try_finetune(api_key: str, jsonl_path: Path, base_model: str) -> str | None:
    """Tente l'API fine-tuning Cerebras. Retourne le model_id ou None si non supporté."""
    headers = {"Authorization": f"Bearer {api_key}"}

    print(f"[cerebras_ft] Probe POST {CEREBRAS_API_BASE}/files (purpose=fine-tune)...")
    try:
        with open(jsonl_path, "rb") as f:
            up = httpx.post(
                f"{CEREBRAS_API_BASE}/files",
                headers=headers,
                files={"file": (jsonl_path.name, f, "application/jsonl")},
                data={"purpose": "fine-tune"},
                timeout=60.0,
            )
        if up.status_code in (404, 405, 501):
            print(f"[cerebras_ft] /files non supporté (status {up.status_code}). Bascule en few-shot.")
            return None
        up.raise_for_status()
        file_id = up.json().get("id")
        print(f"[cerebras_ft] Upload OK, file_id={file_id}")
    except httpx.HTTPError as e:
        print(f"[cerebras_ft] Échec upload : {e}. Bascule en few-shot.")
        return None

    print(f"[cerebras_ft] POST /fine_tuning/jobs base_model={base_model}...")
    try:
        job = httpx.post(
            f"{CEREBRAS_API_BASE}/fine_tuning/jobs",
            headers={**headers, "Content-Type": "application/json"},
            json={"model": base_model, "training_file": file_id},
            timeout=60.0,
        )
        if job.status_code in (404, 405, 501):
            print(f"[cerebras_ft] /fine_tuning/jobs non supporté. Bascule en few-shot.")
            return None
        job.raise_for_status()
        job_id = job.json().get("id")
        print(f"[cerebras_ft] Job créé : {job_id}")
    except httpx.HTTPError as e:
        print(f"[cerebras_ft] Échec création job : {e}. Bascule en few-shot.")
        return None

    print(f"[cerebras_ft] Polling…")
    for _ in range(360):  # max 30 min
        time.sleep(5)
        try:
            r = httpx.get(f"{CEREBRAS_API_BASE}/fine_tuning/jobs/{job_id}", headers=headers, timeout=30.0)
            r.raise_for_status()
            data = r.json()
            status = data.get("status")
            print(f"  status={status}")
            if status == "succeeded":
                model_id = data.get("fine_tuned_model")
                print(f"[cerebras_ft] ✅ Fine-tuning OK : {model_id}")
                return model_id
            if status in ("failed", "cancelled"):
                print(f"[cerebras_ft] Job {status}. Détails : {data}")
                return None
        except httpx.HTTPError as e:
            print(f"[cerebras_ft] Polling error : {e}")
    print("[cerebras_ft] Timeout polling")
    return None


def _build_clean_examples_from_csv(n: int) -> list[dict]:
    """Le JSONL fourni n'a que des FRAUD. On complète avec des CLEAN tirés du CSV."""
    import csv
    csv_path = ROOT / "salam_ammari_dataset" / "Dataset" / "Dataset.csv"
    if not csv_path.exists():
        return []
    out: list[dict] = []
    with open(csv_path, "r", encoding="utf-8", errors="ignore") as f:
        reader = csv.DictReader(f)
        for r in reader:
            if str(r.get("from_scam", "0")).strip() in ("0", "0.0", "False", "false") and \
               str(r.get("to_scam", "0")).strip() in ("0", "0.0", "False", "false"):
                try:
                    val_eth = float(r.get("value", 0)) / 1e18
                except Exception:
                    val_eth = 0.0
                fr = (r.get("from_address") or "")[:10] + "..."
                to = (r.get("to_address") or "")[:10] + "..."
                cat = (r.get("to_category") or "Unknown").strip() or "Unknown"
                prompt = (
                    "Analyze this Ethereum transaction and classify if it's part of a fraudulent flow:\n\n"
                    "Transaction Details:\n"
                    f"- From: {fr}\n- To: {to}\n- Value: {val_eth:.4f} ETH\n- Destination Category: {cat}\n\n"
                    "Classify as:\n- FRAUD: Part of stolen funds flow\n- CLEAN: Legitimate transaction\n- UNKNOWN: Unclear\n\n"
                    "Your answer (one word):"
                )
                out.append({"prompt": prompt, "completion": "CLEAN"})
                if len(out) >= n:
                    break
    return out


def build_fewshot(jsonl_path: Path, n_per_class: int = 6) -> dict:
    rows = load_jsonl(jsonl_path)
    fraud = [r for r in rows if str(r.get("completion", "")).strip().upper() == "FRAUD"]
    clean = [r for r in rows if str(r.get("completion", "")).strip().upper() == "CLEAN"]
    if len(clean) < n_per_class:
        extras = _build_clean_examples_from_csv(n_per_class - len(clean) + 50)
        clean.extend(extras)
    print(f"[cerebras_ft] dataset : {len(fraud)} FRAUD, {len(clean)} CLEAN (total {len(rows)} + extras CSV)")
    rng = random.Random(42)
    sampled = rng.sample(fraud, min(n_per_class, len(fraud))) + rng.sample(clean, min(n_per_class, len(clean)))
    rng.shuffle(sampled)
    examples = [
        {
            "prompt": r.get("prompt", ""),
            "completion": str(r.get("completion", "")).strip(),
        }
        for r in sampled
    ]
    payload = {
        "version": 1,
        "n_examples": len(examples),
        "examples": examples,
    }
    FEWSHOT_OUT.parent.mkdir(parents=True, exist_ok=True)
    FEWSHOT_OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[cerebras_ft] Few-shot examples écrits : {FEWSHOT_OUT} ({len(examples)} exemples)")
    return payload


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["auto", "finetune", "fewshot"], default="auto")
    ap.add_argument("--base-model", default=DEFAULT_BASE_MODEL)
    args = ap.parse_args()

    api_key = os.getenv("CEREBRAS_API_KEY")
    if not api_key and args.mode != "fewshot":
        print("[KO] CEREBRAS_API_KEY manquante.")
        return 1

    if not JSONL_PATH.exists():
        print(f"[KO] {JSONL_PATH} introuvable.")
        return 1

    if args.mode in ("auto", "finetune"):
        model_id = try_finetune(api_key, JSONL_PATH, args.base_model)
        if model_id:
            ENV_OUT.write_text(f"CEREBRAS_FINE_TUNED_MODEL={model_id}\n", encoding="utf-8")
            print(f"[cerebras_ft] {ENV_OUT} mis à jour. Recharge le backend.")
            return 0
        if args.mode == "finetune":
            print("[cerebras_ft] Mode finetune strict — abandon.")
            return 1

    build_fewshot(JSONL_PATH)
    print("[cerebras_ft] Mode few-shot prêt. Le backend chargera les exemples au prochain démarrage.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
