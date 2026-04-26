import { useEffect, useRef } from "react";
import { postAnalyzeGraph } from "@/lib/api";
import type { AmlNode, AmlLink } from "@/lib/aml-data";

const PUSH_INTERVAL_MS = 5000;

export function useLiveAnalysisPush(
  enabled: boolean,
  nodes: AmlNode[],
  links: AmlLink[],
  seedAddress?: string
) {
  // Refs pour toujours envoyer le dernier snapshot sans relancer le timer.
  const nodesRef = useRef(nodes);
  const linksRef = useRef(links);
  nodesRef.current = nodes;
  linksRef.current = links;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const push = async () => {
      const ns = nodesRef.current;
      const ls = linksRef.current;
      if (ns.length === 0) return;
      try {
        await postAnalyzeGraph({
          nodes: ns.slice(0, 200).map((n) => ({
            id: n.id,
            address: n.address,
            score: n.score,
            balance: n.balance,
            hops: n.hops,
          })),
          edges: ls.slice(0, 400).map((l: any) => ({
            source: typeof l.source === "object" ? l.source.id : l.source,
            target: typeof l.target === "object" ? l.target.id : l.target,
            amount: l.amount,
          })),
          seed_address: seedAddress,
          protocol_name: "Simulated Stream",
        });
      } catch (err) {
        console.warn("[useLiveAnalysisPush]", err);
      }
    };

    // Premier push immédiat puis interval.
    void push();
    const id = window.setInterval(() => {
      if (!cancelled) void push();
    }, PUSH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled, seedAddress]);
}
