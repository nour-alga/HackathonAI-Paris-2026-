import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { LiveTransaction } from "@/hooks/useFakeEthStream";
import type { FilterMode } from "@/components/aml/FilterBar";
import { TxScore } from "@/components/aml/TxScore";
import { TxDetailDialog } from "@/components/aml/TxDetailDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { AgentResult, AnalysisComplete } from "@/hooks/useBackendStream";

type Props = {
  onBroadcast: () => void;
  broadcasting: boolean;
  txs: LiveTransaction[];
  launderingCount: number;
  filter: FilterMode;
  selectedTx?: LiveTransaction | null;
  onSelectTx?: (tx: LiveTransaction | null) => void;
  onFreezeAddresses?: () => void;
  frozenCount?: number;
  liveMode?: boolean;
  pathPrediction?: AgentResult | null;
  analysis?: AnalysisComplete | null;
};

const filterLabel: Record<FilterMode, string> = {
  all: "ALL",
  laundering: "LAUNDERING",
  "high-score": "SCORE > 0.7",
};

export const SidePanel = ({
  txs,
  launderingCount,
  filter,
  selectedTx: selectedTxProp,
  onSelectTx,
  liveMode = false,
  pathPrediction = null,
  analysis = null,
}: Props) => {
  const [aiReportOpen, setAiReportOpen] = useState(false);
  const [selectedTxState, setSelectedTxState] = useState<LiveTransaction | null>(null);
  const selectedTx = selectedTxProp !== undefined ? selectedTxProp : selectedTxState;
  const setSelectedTx = (tx: LiveTransaction | null) => {
    if (onSelectTx) onSelectTx(tx);
    else setSelectedTxState(tx);
  };

  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const liveSectionRef = useRef<HTMLElement>(null);
  const [flashHash, setFlashHash] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedTx) return;
    const row = rowRefs.current.get(selectedTx.hash);
    if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
    else if (liveSectionRef.current) liveSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    setFlashHash(selectedTx.hash);
    const id = window.setTimeout(() => setFlashHash(null), 1400);
    return () => window.clearTimeout(id);
  }, [selectedTx]);

  return (
    <aside className="flex h-full w-[350px] shrink-0 flex-col hairline-l bg-background">
      {/* Section 1 — Live Tracking (real backend stream) */}
      <section ref={liveSectionRef} className="flex min-h-0 flex-1 flex-col">
        <header className="border-b-2 border-foreground bg-foreground px-6 py-5 text-background">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-background">
                LIVE_TRACKING / ETH
              </h2>
              {filter !== "all" && (
                <span
                  className={`font-mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 border ${
                    filter === "laundering"
                      ? "border-background bg-alert text-background"
                      : "border-background bg-background text-foreground"
                  }`}
                >
                  {filterLabel[filter]}
                </span>
              )}
            </div>
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-background animate-pulse" />
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-background">
                STREAM
              </span>
            </span>
          </div>
        </header>
        <div className="flex items-center justify-between border-b-2 border-alert bg-alert-soft px-6 py-3">
          <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-alert">
            LAUNDERING_DETECTED
          </span>
          <span className="border border-alert bg-alert px-2 py-1 font-mono text-[12px] font-bold tabular-nums text-background">
            {launderingCount.toLocaleString()}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {txs.length === 0 && (
            <div className="px-6 py-6 font-mono text-[11px] text-ink-muted">
              En attente du flux backend…
            </div>
          )}
          <ul className="divide-y hairline">
            <AnimatePresence initial={false}>
              {txs.map((tx) => (
                <motion.li
                  key={tx.hash}
                  ref={(el) => {
                    if (el) rowRefs.current.set(tx.hash, el);
                    else rowRefs.current.delete(tx.hash);
                  }}
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  onClick={() => setSelectedTx(tx)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedTx(tx);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Inspect transaction ${tx.hash.slice(0, 10)}`}
                  className={`group relative px-6 py-3 cursor-pointer outline-none transition-all border-l-2 border-transparent hover:border-l-foreground hover:bg-foreground/[0.06] focus-visible:border-l-foreground focus-visible:bg-foreground/[0.08] active:bg-foreground/10 ${
                    tx.laundering ? "bg-alert-soft hover:border-l-alert focus-visible:border-l-alert" : ""
                  } ${selectedTx?.hash === tx.hash ? (tx.laundering ? "border-l-alert bg-alert-soft" : "border-l-foreground bg-foreground/[0.08]") : ""} ${flashHash === tx.hash ? "animate-flash-highlight" : ""}`}
                >
                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="text-ink-muted">{tx.time}</span>
                      {tx.laundering && (
                        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-alert">
                          ⚠ AML
                        </span>
                      )}
                    </div>
                    <span className={tx.laundering ? "font-semibold text-alert" : "text-ink"}>
                      {tx.amount.toFixed(tx.amount >= 1 ? 2 : 4)} ETH
                    </span>
                  </div>
                  <div className={`mt-1 flex items-center gap-2 font-mono text-[11px] ${tx.laundering ? "text-alert" : "text-ink"}`}>
                    <span>{tx.source}</span>
                    <span className={tx.laundering ? "text-alert" : "text-ink-faint"}>→</span>
                    <span>{tx.target}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <TxScore hash={tx.hash} laundering={tx.laundering} />
                    <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                      INSPECT →
                    </span>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </div>
      </section>

      {/* Section 2 — AI Backend Analysis (real LSTM/Cerebras) */}
      {liveMode && (
        <section className="hairline-t">
          <header className="flex items-center justify-between px-6 py-4 hairline-b bg-foreground/[0.04]">
            <h2 className="label-micro">AI_ANALYSIS / BACKEND</h2>
            {analysis?.severity && (
              <span
                className={`font-mono text-[10px] font-bold uppercase tracking-[0.14em] px-2 py-0.5 border ${
                  analysis.severity === "CRITICAL" || analysis.severity === "HIGH"
                    ? "border-alert bg-alert text-background"
                    : "border-foreground text-foreground"
                }`}
              >
                {analysis.severity}
              </span>
            )}
          </header>
          <div className="px-6 py-3 space-y-2 font-mono text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">PATH_PREDICTION (LSTM)</span>
              <span className="text-ink">
                {pathPrediction?.prediction ?? "—"}
                {pathPrediction?.probability != null
                  ? ` · ${(pathPrediction.probability * 100).toFixed(0)}%`
                  : ""}
              </span>
            </div>
            <button
              onClick={() => setAiReportOpen(true)}
              disabled={!analysis?.narrative}
              className="w-full mt-2 border border-foreground py-2 font-mono text-[10px] uppercase tracking-[0.14em] hover:bg-foreground hover:text-background disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-foreground"
            >
              {analysis?.narrative ? "VIEW_INCIDENT_REPORT (Cerebras) →" : "AWAITING_REPORT…"}
            </button>
          </div>
        </section>
      )}

      <TxDetailDialog tx={selectedTx} onClose={() => setSelectedTx(null)} />

      {/* AI Incident Report dialog (real Cerebras output) */}
      <Dialog open={aiReportOpen} onOpenChange={setAiReportOpen}>
        <DialogContent className="max-w-2xl border-foreground bg-background p-0">
          <DialogHeader className="hairline-b px-6 py-5">
            <div className="flex items-center justify-between">
              <DialogTitle className="label-micro text-foreground">
                AI_INCIDENT_REPORT / CEREBRAS
              </DialogTitle>
              {analysis?.severity && (
                <span
                  className={`font-mono text-[10px] font-bold uppercase tracking-[0.14em] px-2 py-0.5 border ${
                    analysis.severity === "CRITICAL" || analysis.severity === "HIGH"
                      ? "border-alert bg-alert text-background"
                      : "border-foreground text-foreground"
                  }`}
                >
                  {analysis.severity}
                </span>
              )}
            </div>
          </DialogHeader>
          <div className="space-y-4 px-6 py-5 max-h-[60vh] overflow-y-auto">
            {analysis?.summary && (
              <div className="font-mono text-[11px] text-ink-muted">{analysis.summary}</div>
            )}
            <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink">
              {analysis?.narrative ?? "—"}
            </pre>
          </div>
          <DialogFooter className="hairline-t px-6 py-4">
            <button
              onClick={() => setAiReportOpen(false)}
              className="w-full border border-foreground bg-foreground py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-background hover:opacity-90"
            >
              CLOSE
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
};
