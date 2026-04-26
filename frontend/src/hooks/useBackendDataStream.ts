import { useEffect, useRef, useState } from "react";
import { API_BASE, WS_URL } from "@/lib/api";
import type { AmlNode, AmlLink } from "@/lib/aml-data";
import type { LiveTransaction } from "@/hooks/useFakeEthStream";

const fmtTime = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export type GatInference = {
  latency_ms: number;
  nodes_scored: number;
  max_score: number;
  score_distribution: number[];
  ts: number;
};

export type LstmInference = {
  latency_ms: number;
  prediction: string;
  confidence: number;
  probabilities: Record<string, number>;
  input_addresses: string[];
  ts: number;
};

export type CerebrasState = {
  request_id: string | null;
  model_id: string;
  streaming: boolean;
  text: string;
  tokens: number;
  elapsed_ms: number;
  tokens_per_sec: number;
  last_complete_text: string | null;
};

export type AiManifest = {
  manifest: {
    issued_at_ms: number;
    models: {
      gat: any;
      lstm: any;
      cerebras: any;
    };
    inference_counts_total: Record<string, number>;
    inference_log_recent: any[];
  };
  signature_hmac_sha256: string;
  verify_with: string;
};

export type BackendDataStream = {
  isConnected: boolean;
  running: boolean;
  nodes: AmlNode[];
  links: AmlLink[];
  txs: LiveTransaction[];
  stats: { volumeEth: number; count: number; launderingCount: number };
  gat: GatInference | null;
  gatHistory: GatInference[];
  lstm: LstmInference | null;
  lstmHistory: LstmInference[];
  cerebras: CerebrasState;
  manifest: AiManifest | null;
  inferenceCounts: Record<string, number>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

const initialCerebras: CerebrasState = {
  request_id: null,
  model_id: "qwen-3-235b-a22b-instruct-2507",
  streaming: false,
  text: "",
  tokens: 0,
  elapsed_ms: 0,
  tokens_per_sec: 0,
  last_complete_text: null,
};

export function useBackendDataStream(): BackendDataStream {
  const [isConnected, setIsConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [nodes, setNodes] = useState<AmlNode[]>([]);
  const [links, setLinks] = useState<AmlLink[]>([]);
  const [txs, setTxs] = useState<LiveTransaction[]>([]);
  const [stats, setStats] = useState({ volumeEth: 0, count: 0, launderingCount: 0 });
  const [gat, setGat] = useState<GatInference | null>(null);
  const [gatHistory, setGatHistory] = useState<GatInference[]>([]);
  const [lstm, setLstm] = useState<LstmInference | null>(null);
  const [lstmHistory, setLstmHistory] = useState<LstmInference[]>([]);
  const [cerebras, setCerebras] = useState<CerebrasState>(initialCerebras);
  const [manifest, setManifest] = useState<AiManifest | null>(null);
  const [inferenceCounts, setInferenceCounts] = useState<Record<string, number>>({});
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;

    const connect = () => {
      if (cancelled) return;
      console.log("[ai-stream] connecting to", WS_URL);
      let ws: WebSocket;
      try {
        ws = new WebSocket(WS_URL);
      } catch (e) {
        console.error("[ai-stream] WS construct failed", e);
        retryTimer = window.setTimeout(connect, 3000);
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        console.log("[ai-stream] WS open ✓");
        setIsConnected(true);
      };
      ws.onerror = (e) => {
        console.error("[ai-stream] WS error", e);
        ws.close();
      };
      ws.onclose = (e) => {
        console.warn("[ai-stream] WS close", e.code, e.reason);
        if (cancelled) return;
        setIsConnected(false);
        retryTimer = window.setTimeout(connect, 3000);
      };
      ws.onmessage = (msg) => {
        let parsed: any;
        try { parsed = JSON.parse(msg.data); } catch (e) { console.error("[ai-stream] parse fail", e); return; }
        const ev = parsed.event;
        const d = parsed.data ?? {};
        if (ev !== "tx_generated" && ev !== "graph_state") {
          console.log("[ai-stream] event", ev, d);
        }

        if (ev === "tx_generated") {
          const tx: LiveTransaction = {
            hash: d.hash,
            time: fmtTime(d.ts_ms ?? Date.now()),
            source: short(d.from),
            target: short(d.to),
            sourceFull: d.from,
            targetFull: d.to,
            amount: d.value_eth,
            laundering: !!d.is_fraud,
          };
          setTxs((prev) => [tx, ...prev].slice(0, 80));
          setStats((s) => ({
            volumeEth: s.volumeEth + (d.value_eth || 0),
            count: s.count + 1,
            launderingCount: s.launderingCount + (d.is_fraud ? 1 : 0),
          }));
        } else if (ev === "graph_state") {
          setNodes((d.nodes || []) as AmlNode[]);
          setLinks((d.edges || []) as AmlLink[]);
        } else if (ev === "gat_inference") {
          const g: GatInference = {
            latency_ms: d.latency_ms,
            nodes_scored: d.nodes_scored,
            max_score: d.max_score,
            score_distribution: d.score_distribution || [],
            ts: Date.now(),
          };
          setGat(g);
          setGatHistory((h) => [g, ...h].slice(0, 30));
          setInferenceCounts((c) => ({ ...c, gat: (c.gat || 0) + 1 }));
        } else if (ev === "lstm_inference") {
          const l: LstmInference = {
            latency_ms: d.latency_ms,
            prediction: d.prediction,
            confidence: d.confidence,
            probabilities: d.probabilities || {},
            input_addresses: d.input_addresses || [],
            ts: Date.now(),
          };
          setLstm(l);
          setLstmHistory((h) => [l, ...h].slice(0, 30));
          setInferenceCounts((c) => ({ ...c, lstm: (c.lstm || 0) + 1 }));
        } else if (ev === "cerebras_start") {
          setCerebras({
            ...initialCerebras,
            request_id: d.request_id,
            model_id: d.model_id,
            streaming: true,
            last_complete_text: cerebras.last_complete_text,
          });
        } else if (ev === "cerebras_token") {
          setCerebras((c) => ({
            ...c,
            text: c.text + (d.delta || ""),
            tokens: d.token_index,
            elapsed_ms: d.elapsed_ms,
            tokens_per_sec: d.elapsed_ms > 0 ? Math.round((d.token_index * 1000) / d.elapsed_ms) : 0,
          }));
        } else if (ev === "cerebras_complete") {
          setCerebras((c) => ({
            ...c,
            streaming: false,
            elapsed_ms: d.latency_ms,
            tokens_per_sec: d.tokens_per_sec,
            last_complete_text: d.full_text,
          }));
          setInferenceCounts((cc) => ({ ...cc, cerebras: (cc.cerebras || 0) + 1 }));
        } else if (ev === "ai_manifest") {
          setManifest(d as AiManifest);
        } else if (ev === "stream_reset") {
          // Backend a vidé son state — on synchronise le front pour pas garder
          // d'ancien graph / compteurs / inférences fantôme.
          setNodes([]);
          setLinks([]);
          setTxs([]);
          setStats({ volumeEth: 0, count: 0, launderingCount: 0 });
          setGat(null);
          setGatHistory([]);
          setLstm(null);
          setLstmHistory([]);
          setCerebras(initialCerebras);
          setInferenceCounts({});
        } else if (ev === "ai_error") {
          console.warn("[ai_error]", d);
        }
      };
    };
    connect();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  // cerebras.last_complete_text dep is intentionally omitted to avoid reconnect storms
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    await fetch(`${API_BASE}/stream/start`, { method: "POST" });
    setRunning(true);
    // Refresh manifest
    try {
      const r = await fetch(`${API_BASE}/ai/proof`);
      const m = await r.json();
      setManifest(m as AiManifest);
    } catch {}
  };
  const stop = async () => {
    await fetch(`${API_BASE}/stream/stop`, { method: "POST" });
    setRunning(false);
  };

  return { isConnected, running, nodes, links, txs, stats, gat, gatHistory, lstm, lstmHistory, cerebras, manifest, inferenceCounts, start, stop };
}
