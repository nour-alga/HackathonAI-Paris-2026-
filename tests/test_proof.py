"""Tests du module de provenance IA (manifest signé HMAC, checksums)."""
import hashlib
import hmac
import json
from pathlib import Path

import pytest

from backend.streaming import proof


class TestSha256File:
    def test_sha256_existing_file(self, tmp_path):
        f = tmp_path / "fixture.bin"
        f.write_bytes(b"kover-ai")
        expected = hashlib.sha256(b"kover-ai").hexdigest()
        assert proof.sha256_file(f) == expected

    def test_sha256_missing_file_returns_empty(self, tmp_path):
        missing = tmp_path / "nope.bin"
        assert proof.sha256_file(missing) == ""

    def test_sha256_handles_large_file_streaming(self, tmp_path):
        # > 64KB pour exercer la boucle de chunks
        f = tmp_path / "big.bin"
        payload = b"A" * (64 * 1024 + 100)
        f.write_bytes(payload)
        expected = hashlib.sha256(payload).hexdigest()
        assert proof.sha256_file(f) == expected


class TestInferenceLog:
    def test_record_inference_appends(self):
        entry = proof.record_inference("gat", 12.3, {"nodes": 50})
        assert entry["model"] == "gat"
        assert entry["latency_ms"] == 12.3
        assert entry["nodes"] == 50
        assert "ts_ms" in entry
        assert proof.inference_log()[-1] == entry

    def test_inference_counts_aggregates(self):
        proof.record_inference("gat", 1.0)
        proof.record_inference("gat", 2.0)
        proof.record_inference("lstm", 3.0)
        c = proof.inference_counts()
        assert c["gat"] == 2
        assert c["lstm"] == 1

    def test_log_caps_at_max(self):
        for i in range(proof._MAX_LOG + 50):
            proof.record_inference("gat", float(i))
        # Doit être plafonné
        assert len(proof._inference_log) <= proof._MAX_LOG

    def test_reset_log_clears(self):
        proof.record_inference("gat", 1.0)
        proof.record_inference("lstm", 2.0)
        assert len(proof._inference_log) >= 2
        proof.reset_log()
        assert len(proof._inference_log) == 0


class TestManifest:
    def test_manifest_structure(self):
        m = proof.build_manifest()
        assert "manifest" in m
        assert "signature_hmac_sha256" in m
        assert "verify_with" in m
        body = m["manifest"]
        assert "issued_at_ms" in body
        assert "models" in body
        for k in ("gat", "lstm", "cerebras"):
            assert k in body["models"]

    def test_manifest_signature_is_valid_hmac(self):
        m = proof.build_manifest()
        body_json = json.dumps(m["manifest"], sort_keys=True, separators=(",", ":")).encode()
        expected = hmac.new(proof._HMAC_SECRET.encode(), body_json, hashlib.sha256).hexdigest()
        assert m["signature_hmac_sha256"] == expected

    def test_manifest_signature_changes_with_content(self):
        m1 = proof.build_manifest()
        proof.record_inference("gat", 99.9)
        m2 = proof.build_manifest()
        # Le contenu a changé donc la signature aussi
        assert m1["signature_hmac_sha256"] != m2["signature_hmac_sha256"]

    def test_manifest_includes_model_metadata(self):
        m = proof.build_manifest()
        gat = m["manifest"]["models"]["gat"]
        assert gat["name"] == "FraudGAT"
        assert "checkpoint_sha256" in gat
        assert "training_metrics" in gat
        assert gat["training_metrics"]["val_accuracy"] == 0.97

    def test_manifest_lstm_metadata_has_classes(self):
        m = proof.build_manifest()
        lstm = m["manifest"]["models"]["lstm"]
        assert "output_classes" in lstm
        assert "training_classes" in lstm  # les vraies classes du dataset
