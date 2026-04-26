import { useEffect, useMemo, useState } from "react";
import { Header } from "@/components/aml/Header";
import { SidePanel } from "@/components/aml/SidePanel";
import { ForceGraph } from "@/components/aml/ForceGraph";
import { FilterBar, type FilterMode } from "@/components/aml/FilterBar";
import { AiTelemetryPanel } from "@/components/aml/AiTelemetryPanel";
import type { AmlNode, AmlLink } from "@/lib/aml-data";
import type { LiveTransaction } from "@/hooks/useFakeEthStream";
import { useBackendDataStream } from "@/hooks/useBackendDataStream";

const fmtTime = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

const Index = () => {
  const ai = useBackendDataStream();
  const [filter, setFilter] = useState<FilterMode>("all");
  const [selectedTx, setSelectedTx] = useState<LiveTransaction | null>(null);

  // Auto-start stream à la connexion WS
  useEffect(() => {
    if (ai.isConnected && !ai.running) {
      ai.start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai.isConnected]);

  const matchesFilter = (n: AmlNode, f: FilterMode) => {
    if (f === "all") return true;
    if (f === "laundering") return n.blacklisted;
    if (f === "high-score") return n.score > 0.7;
    return true;
  };

  const { nodes, links } = useMemo(() => {
    if (filter === "all") return { nodes: ai.nodes, links: ai.links };
    const allowed = new Set(ai.nodes.filter((n) => matchesFilter(n, filter)).map((n) => n.id));
    return {
      nodes: ai.nodes.filter((n) => allowed.has(n.id)),
      links: ai.links.filter((l: any) => {
        const s = typeof l.source === "object" ? l.source.id : l.source;
        const t = typeof l.target === "object" ? l.target.id : l.target;
        return allowed.has(s) && allowed.has(t);
      }),
    };
  }, [ai.nodes, ai.links, filter]);

  const counts = useMemo(
    () => ({
      all: ai.nodes.length,
      laundering: ai.nodes.filter((n) => n.blacklisted).length,
      highScore: ai.nodes.filter((n) => (n.score ?? 0) > 0.7).length,
    }),
    [ai.nodes]
  );

  const filteredTxs = useMemo(() => {
    if (filter === "all") return ai.txs;
    if (filter === "laundering") return ai.txs.filter((t) => t.laundering);
    return ai.txs.filter((t) => {
      const n = ai.nodes.find((x) => x.id === t.sourceFull || x.id === t.targetFull);
      return n && matchesFilter(n, filter);
    });
  }, [ai.txs, ai.nodes, filter]);

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  const openSyntheticTx = (sourceId: string, targetId: string, amount?: number) => {
    const targetNode = ai.nodes.find((n) => n.id === targetId);
    setSelectedTx({
      hash: `0x${targetId.slice(2, 10)}${Date.now().toString(16)}`.padEnd(66, "0"),
      time: fmtTime(),
      source: short(sourceId),
      target: short(targetId),
      sourceFull: sourceId,
      targetFull: targetId,
      amount: amount ?? +(targetNode?.balance ?? 0.5).toFixed(4),
      laundering: !!targetNode?.blacklisted,
    });
  };

  const handleInspectNode = (node: AmlNode) => {
    const candidates = ai.txs.filter((t) => t.sourceFull === node.id || t.targetFull === node.id);
    const tx = node.blacklisted ? candidates.find((t) => t.laundering) ?? candidates[0] : candidates[0];
    if (tx) {
      setSelectedTx(tx);
      return;
    }
    openSyntheticTx("0x0000000000000000000000000000000000000000", node.id, +(node.balance ?? 0.5).toFixed(4));
  };

  const handleInspectLink = (link: any) => {
    const sourceId = typeof link.source === "object" ? link.source.id : link.source;
    const targetId = typeof link.target === "object" ? link.target.id : link.target;
    const tx =
      ai.txs.find((t) => t.sourceFull === sourceId && t.targetFull === targetId) ??
      ai.txs.find((t) => t.sourceFull === targetId && t.targetFull === sourceId);
    if (tx) setSelectedTx(tx);
    else openSyntheticTx(sourceId, targetId, link.amount);
  };

  // Pipeline step pour le Header (déduit du dernier événement)
  const pipelineStep = ai.cerebras.streaming
    ? "generating_narrative"
    : ai.lstm
    ? "path_prediction"
    : ai.gat
    ? "building_graph"
    : "idle";

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground">
      <Header
        liveVolume={ai.stats.volumeEth}
        liveCount={ai.stats.count}
        launderingCount={ai.stats.launderingCount}
        paused={!ai.running}
        onTogglePause={() => (ai.running ? ai.stop() : ai.start())}
        liveMode={ai.running}
        onToggleLiveMode={() => (ai.running ? ai.stop() : ai.start())}
        backendConnected={ai.isConnected}
        pipelineStep={pipelineStep as any}
      />
      <main className="flex min-h-0 flex-1">
        <section className="relative min-w-0 flex-1">
          <div className="absolute left-6 top-6 z-10 space-y-3">
            <div>
              <div className="label-micro">GRAPH / LIVE_AI_STREAM</div>
              <div className="font-mono text-[11px] text-ink">
                NODES {nodes.length} · LINKS {links.length} · TX {ai.stats.count}
              </div>
            </div>
            <FilterBar value={filter} onChange={setFilter} counts={counts} />
          </div>
          <ForceGraph
            nodes={nodes}
            links={links}
            scanning={false}
            onInspectNode={handleInspectNode}
            onInspectLink={handleInspectLink}
            frozenAddresses={new Set()}
          />
        </section>
        <SidePanel
          onBroadcast={() => {}}
          broadcasting={false}
          txs={filteredTxs}
          launderingCount={ai.stats.launderingCount}
          filter={filter}
          selectedTx={selectedTx}
          onSelectTx={setSelectedTx}
          liveMode={ai.running}
          pathPrediction={ai.lstm ? { agent: "PathPredictor", prediction: ai.lstm.prediction, probability: ai.lstm.confidence } : null}
          analysis={ai.cerebras.last_complete_text ? {
            severity: (ai.gat?.max_score ?? 0) > 0.8 ? "CRITICAL" : (ai.gat?.max_score ?? 0) > 0.5 ? "HIGH" : "MEDIUM",
            summary: `Stream: ${ai.nodes.length} wallets, ${ai.stats.launderingCount} flagged`,
            narrative: ai.cerebras.last_complete_text,
            path_prediction: { next_destination: ai.lstm?.prediction, probability: ai.lstm?.confidence },
          } : null}
        />
        <aside className="flex h-full w-[380px] shrink-0 flex-col hairline-l bg-background overflow-y-auto">
          <AiTelemetryPanel
            manifest={ai.manifest}
            gat={ai.gat}
            lstm={ai.lstm}
            cerebras={ai.cerebras}
            inferenceCounts={ai.inferenceCounts}
          />
        </aside>
      </main>
    </div>
  );
};

export default Index;
