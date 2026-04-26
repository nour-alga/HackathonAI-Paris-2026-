import { useEffect, useRef, useState } from "react";
import { WS_URL } from "@/lib/api";

export type PipelineStep =
  | "idle"
  | "building_graph"
  | "path_prediction"
  | "generating_narrative"
  | "complete";

export type AgentResult = {
  agent: string;
  prediction?: string;
  probability?: number;
  report_length?: number;
};

export type AnalysisComplete = {
  severity: string;
  summary: string;
  narrative: string;
  path_prediction: { next_destination?: string; probability?: number; [k: string]: any };
  graph_summary?: any;
  tainted_wallets?: Array<{ address: string; score: number; type: string }>;
};

export type BackendStreamState = {
  isConnected: boolean;
  pipelineStep: PipelineStep;
  taintOverrides: Map<string, number>; // id -> taint_score 0..1
  pathPrediction: AgentResult | null;
  reporterStatus: AgentResult | null;
  analysis: AnalysisComplete | null;
};

const initialState: BackendStreamState = {
  isConnected: false,
  pipelineStep: "idle",
  taintOverrides: new Map(),
  pathPrediction: null,
  reporterStatus: null,
  analysis: null,
};

export function useBackendStream(enabled: boolean): BackendStreamState {
  const [state, setState] = useState<BackendStreamState>(initialState);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled) {
      wsRef.current?.close();
      wsRef.current = null;
      setState(initialState);
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;

    const connect = () => {
      if (cancelled) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(WS_URL);
      } catch {
        retryTimer = window.setTimeout(connect, 3000);
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        setState((s) => ({ ...s, isConnected: true }));
      };

      ws.onclose = () => {
        if (cancelled) return;
        setState((s) => ({ ...s, isConnected: false }));
        retryTimer = window.setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = (msg) => {
        let parsed: any;
        try {
          parsed = JSON.parse(msg.data);
        } catch {
          return;
        }
        const event: string = parsed.event ?? parsed.type ?? "";
        const data = parsed.data ?? parsed;

        if (event === "pipeline_status") {
          const step = (data.step ?? "idle") as PipelineStep;
          setState((s) => ({ ...s, pipelineStep: step }));
        } else if (event === "graph_update") {
          const overrides = new Map<string, number>();
          for (const n of data.nodes ?? []) {
            if (n.id != null && typeof n.taint_score === "number") {
              overrides.set(String(n.id), n.taint_score);
            }
          }
          setState((s) => ({ ...s, taintOverrides: overrides }));
        } else if (event === "agent_result") {
          setState((s) => {
            if (data.agent === "PathPredictor") return { ...s, pathPrediction: data };
            if (data.agent === "IncidentReporter") return { ...s, reporterStatus: data };
            return s;
          });
        } else if (event === "analysis_complete") {
          setState((s) => ({
            ...s,
            pipelineStep: "complete",
            analysis: data as AnalysisComplete,
          }));
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
  }, [enabled]);

  return state;
}
