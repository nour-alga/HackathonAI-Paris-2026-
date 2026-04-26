import { useMemo, useState } from "react";
import { Header } from "@/components/aml/Header";
import { SidePanel } from "@/components/aml/SidePanel";
import { ForceGraph } from "@/components/aml/ForceGraph";
import { FilterBar, type FilterMode } from "@/components/aml/FilterBar";
import { generateGraph, type AmlNode, type AmlLink } from "@/lib/aml-data";
import { useFakeEthStream, type LiveTransaction } from "@/hooks/useFakeEthStream";
import { useBackendStream } from "@/hooks/useBackendStream";
import { useLiveAnalysisPush } from "@/hooks/useLiveAnalysisPush";

const fmtTime = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

const Index = () => {
  const seed = useMemo(() => generateGraph(150), []);
  const { txs, nodes: liveNodes, links: liveLinks, stats, paused, togglePause } = useFakeEthStream();
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [selectedTx, setSelectedTx] = useState<LiveTransaction | null>(null);
  const [frozenAddresses, setFrozenAddresses] = useState<Set<string>>(new Set());
  const [liveMode, setLiveMode] = useState(false);

  const backend = useBackendStream(liveMode);

  // Merge seed + live, puis applique les overrides de taint score venant du backend.
  const merged = useMemo(() => {
    const map = new Map<string, AmlNode>();
    seed.nodes.forEach((n) => map.set(n.id, n));
    liveNodes.forEach((n) => map.set(n.id, n));
    if (backend.taintOverrides.size > 0) {
      for (const [id, n] of map) {
        const lower = id.toLowerCase();
        const override =
          backend.taintOverrides.get(id) ??
          backend.taintOverrides.get(lower) ??
          backend.taintOverrides.get(n.address?.toLowerCase() ?? "");
        if (override != null) {
          map.set(id, {
            ...n,
            score: override,
            criticality: Math.round(override * 100),
          });
        }
      }
    }
    const allLinks: AmlLink[] = [...seed.links, ...liveLinks];
    return { nodes: Array.from(map.values()), links: allLinks };
  }, [seed, liveNodes, liveLinks, backend.taintOverrides]);

  useLiveAnalysisPush(liveMode, merged.nodes, merged.links, "src");

  const matchesFilter = (n: AmlNode, f: FilterMode) => {
    if (f === "all") return true;
    if (f === "laundering") return n.blacklisted;
    if (f === "high-score") return n.score > 0.7;
    return true;
  };

  // Apply filter to graph
  const { nodes, links } = useMemo(() => {
    if (filter === "all") return merged;
    const allowed = new Set(
      merged.nodes.filter((n) => matchesFilter(n, filter)).map((n) => n.id)
    );
    return {
      nodes: merged.nodes.filter((n) => allowed.has(n.id)),
      links: merged.links.filter((l: any) => {
        const sId = typeof l.source === "object" ? l.source.id : l.source;
        const tId = typeof l.target === "object" ? l.target.id : l.target;
        return allowed.has(sId) && allowed.has(tId);
      }),
    };
  }, [merged, filter]);

  // Filter the live feed: a tx matches if either side is in the filtered set,
  // or by the laundering flag for the laundering filter.
  const nodeIndex = useMemo(() => {
    const m = new Map<string, AmlNode>();
    merged.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [merged]);

  const filteredTxs = useMemo(() => {
    if (filter === "all") return txs;
    return txs.filter((tx) => {
      if (filter === "laundering") return tx.laundering;
      const s = nodeIndex.get(tx.sourceFull);
      const t = nodeIndex.get(tx.targetFull);
      return (s && matchesFilter(s, filter)) || (t && matchesFilter(t, filter));
    });
  }, [txs, filter, nodeIndex]);

  const counts = useMemo(
    () => ({
      all: merged.nodes.length,
      laundering: merged.nodes.filter((n) => n.blacklisted).length,
      highScore: merged.nodes.filter((n) => n.score > 0.7).length,
    }),
    [merged]
  );

  const triggerScan = () => {
    setScanning(true);
    setTimeout(() => setScanning(false), 1800);
  };

  const freezeBlacklisted = () => {
    setFrozenAddresses((prev) => {
      const next = new Set(prev);
      merged.nodes.forEach((n) => {
        if (n.blacklisted) next.add(n.id);
      });
      return next;
    });
  };

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  const openSyntheticTx = (sourceId: string, targetId: string, amount?: number) => {
    const targetNode = nodeIndex.get(targetId) ?? nodeIndex.get(sourceId);
    const synthetic: LiveTransaction = {
      hash: `0x${targetId.slice(2, 10)}${Date.now().toString(16)}`.padEnd(66, "0"),
      time: fmtTime(),
      source: short(sourceId),
      target: short(targetId),
      sourceFull: sourceId,
      targetFull: targetId,
      amount: amount ?? +(targetNode?.balance ?? 0.5).toFixed(4),
      laundering: !!targetNode?.blacklisted,
    };
    setSelectedTx(synthetic);
  };

  const handleInspectNode = (node: AmlNode) => {
    const nodeId = node.id;

    // 1. Prefer a live tx involving this address — for blacklisted nodes,
    //    prioritize a laundering tx so the highlighted row matches the red node.
    const candidates = txs.filter(
      (t) => t.sourceFull === nodeId || t.targetFull === nodeId
    );
    const relatedTx = node.blacklisted
      ? candidates.find((t) => t.laundering) ?? candidates[0]
      : candidates[0];
    if (relatedTx) {
      setSelectedTx(relatedTx);
      return;
    }

    // 2. Fall back to any graph link involving this address
    const counterparty = merged.links.find((l: any) => {
      const sId = typeof l.source === "object" ? l.source.id : l.source;
      const tId = typeof l.target === "object" ? l.target.id : l.target;
      return sId === nodeId || tId === nodeId;
    }) as any;

    if (counterparty) {
      const sId =
        typeof counterparty.source === "object"
          ? counterparty.source.id
          : counterparty.source;
      const tId =
        typeof counterparty.target === "object"
          ? counterparty.target.id
          : counterparty.target;
      // Orient so the clicked node is the *target* (subject of the inspection)
      if (tId === nodeId) openSyntheticTx(sId, nodeId, counterparty.amount);
      else openSyntheticTx(nodeId, tId, counterparty.amount);
      return;
    }

    // 3. Orphan node — still open the popup with a placeholder source so
    //    the user always gets feedback when clicking an address.
    openSyntheticTx(
      "0x0000000000000000000000000000000000000000",
      nodeId,
      +(node.balance ?? 0.5).toFixed(4)
    );
  };

  const handleInspectLink = (link: any) => {
    const sourceId = typeof link.source === "object" ? link.source.id : link.source;
    const targetId = typeof link.target === "object" ? link.target.id : link.target;
    // Match a live tx in either direction so red link clicks always find their row.
    const relatedTx =
      txs.find((t) => t.sourceFull === sourceId && t.targetFull === targetId) ??
      txs.find((t) => t.sourceFull === targetId && t.targetFull === sourceId) ??
      txs.find((t) => t.sourceFull === sourceId || t.targetFull === targetId);
    if (relatedTx) setSelectedTx(relatedTx);
    else openSyntheticTx(sourceId, targetId, link.amount);
  };

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground">
      <Header
        liveVolume={stats.volumeEth}
        liveCount={stats.count}
        launderingCount={stats.launderingCount}
        paused={paused}
        onTogglePause={togglePause}
        liveMode={liveMode}
        onToggleLiveMode={() => setLiveMode((v) => !v)}
        backendConnected={backend.isConnected}
        pipelineStep={backend.pipelineStep}
      />
      <main className="flex min-h-0 flex-1">
        <section className="relative min-w-0 flex-1">
          <div className="absolute left-6 top-6 z-10 space-y-3">
            <div>
              <div className="label-micro">GRAPH / ETH_SIMULATION</div>
              <div className="font-mono text-[11px] text-ink">
                NODES {nodes.length} · LINKS {links.length}
              </div>
            </div>
            <FilterBar value={filter} onChange={setFilter} counts={counts} />
          </div>
          <ForceGraph
            nodes={nodes}
            links={links}
            scanning={scanning}
            onInspectNode={handleInspectNode}
            onInspectLink={handleInspectLink}
            frozenAddresses={frozenAddresses}
          />
        </section>
        <SidePanel
          onBroadcast={triggerScan}
          broadcasting={scanning}
          txs={filteredTxs}
          launderingCount={stats.launderingCount}
          filter={filter}
          selectedTx={selectedTx}
          onSelectTx={setSelectedTx}
          onFreezeAddresses={freezeBlacklisted}
          frozenCount={frozenAddresses.size}
          liveMode={liveMode}
          pathPrediction={backend.pathPrediction}
          analysis={backend.analysis}
        />
      </main>
    </div>
  );
};

export default Index;
