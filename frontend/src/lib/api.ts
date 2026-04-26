// Client API minimal vers le backend KOVER.IA.
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8000";

export const WS_URL: string =
  (import.meta.env.VITE_WS_URL as string | undefined) ?? "ws://localhost:8000/ws";

export type AnalyzeGraphPayload = {
  nodes: Array<{
    id: string;
    address?: string;
    score?: number;
    balance?: number;
    hops?: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    amount?: number;
  }>;
  seed_address?: string;
  amount_eth?: number;
  protocol_name?: string;
};

export async function postAnalyzeGraph(payload: AnalyzeGraphPayload): Promise<{ status: string }> {
  const resp = await fetch(`${API_BASE}/analyze/graph`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`analyze/graph failed: ${resp.status}`);
  return resp.json();
}
