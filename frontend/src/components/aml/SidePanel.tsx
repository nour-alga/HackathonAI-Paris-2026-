import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { destinations } from "@/lib/aml-data";
import type { LiveTransaction } from "@/hooks/useFakeEthStream";
import type { FilterMode } from "@/components/aml/FilterBar";
import type { AgentResult, AnalysisComplete } from "@/hooks/useBackendStream";
import { TxScore } from "@/components/aml/TxScore";
import { TxDetailDialog } from "@/components/aml/TxDetailDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";

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

type Phase = "idle" | "scanning" | "signing" | "broadcasting" | "confirming" | "confirmed";

type LogEntry = {
  id: string;
  time: string;
  phase: Exclude<Phase, "idle">;
  message: string;
  hash?: string;
};

const PHASE_LABEL: Record<Exclude<Phase, "idle">, string> = {
  scanning: "SCAN_GRAPH",
  signing: "SIGN_PAYLOAD",
  broadcasting: "BROADCAST_TX",
  confirming: "AWAIT_CONFIRMATION",
  confirmed: "DAO_RECEIVED",
};

const PHASE_DURATIONS: Record<Exclude<Phase, "idle" | "confirmed">, number> = {
  scanning: 900,
  signing: 700,
  broadcasting: 800,
  confirming: 1100,
};

const fmtTime = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

const randTxHash = () => {
  const chars = "0123456789abcdef";
  let s = "0x";
  for (let i = 0; i < 64; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
};

export const SidePanel = ({ onBroadcast, broadcasting, txs, launderingCount, filter, selectedTx: selectedTxProp, onSelectTx, onFreezeAddresses, frozenCount = 0, liveMode = false, pathPrediction = null, analysis = null }: Props) => {
  const [reportOpen, setReportOpen] = useState(false);
  const [aiReportOpen, setAiReportOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [currentTxHash, setCurrentTxHash] = useState<string | null>(null);
  const [selectedTxState, setSelectedTxState] = useState<LiveTransaction | null>(null);
  const selectedTx = selectedTxProp !== undefined ? selectedTxProp : selectedTxState;
  const setSelectedTx = (tx: LiveTransaction | null) => {
    if (onSelectTx) onSelectTx(tx);
    else setSelectedTxState(tx);
  };
  const timeouts = useRef<number[]>([]);

  // Pick the most suspicious recent tx to feature in the report
  const flaggedTx = useMemo(
    () => txs.find((t) => t.laundering) ?? txs[0],
    [txs]
  );

  const reportId = useMemo(
    () => `KVR-${Date.now().toString(36).toUpperCase().slice(-6)}`,
    [reportOpen]
  );

  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const listScrollRef = useRef<HTMLDivElement>(null);
  const liveSectionRef = useRef<HTMLElement>(null);
  const [flashHash, setFlashHash] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      timeouts.current.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  // Auto-scroll + flash the selected tx row when selection changes
  useEffect(() => {
    if (!selectedTx) return;
    const row = rowRefs.current.get(selectedTx.hash);
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (liveSectionRef.current) {
      // Tx not in current list (e.g. synthetic from graph click) — at least scroll the section into view
      liveSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    setFlashHash(selectedTx.hash);
    const id = window.setTimeout(() => setFlashHash(null), 1400);
    return () => window.clearTimeout(id);
  }, [selectedTx]);

  const pushLog = (entry: Omit<LogEntry, "id" | "time">) =>
    setLog((prev) =>
      [
        { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, time: fmtTime(), ...entry },
        ...prev,
      ].slice(0, 30)
    );

  const isRunning = phase !== "idle" && phase !== "confirmed";

  const handleBroadcast = () => {
    if (isRunning) return;
    onBroadcast();
    const hash = randTxHash();
    setCurrentTxHash(hash);
    setReportOpen(false);

    // Phase 1 — scanning
    setPhase("scanning");
    pushLog({ phase: "scanning", message: "Analyse du sous-graphe suspect…" });

    // Phase 2 — signing
    timeouts.current.push(
      window.setTimeout(() => {
        setPhase("signing");
        pushLog({ phase: "signing", message: "Signature EIP-712 du rapport AML." });
      }, PHASE_DURATIONS.scanning)
    );

    // Phase 3 — broadcasting on-chain
    timeouts.current.push(
      window.setTimeout(() => {
        setPhase("broadcasting");
        pushLog({
          phase: "broadcasting",
          message: "Diffusion on-chain → DAO_GOVERNOR.",
          hash,
        });
      }, PHASE_DURATIONS.scanning + PHASE_DURATIONS.signing)
    );

    // Phase 4 — awaiting confirmation
    timeouts.current.push(
      window.setTimeout(() => {
        setPhase("confirming");
        pushLog({ phase: "confirming", message: "En attente de confirmation block…" });
      }, PHASE_DURATIONS.scanning + PHASE_DURATIONS.signing + PHASE_DURATIONS.broadcasting)
    );

    // Phase 5 — confirmed → open report
    timeouts.current.push(
      window.setTimeout(() => {
        setPhase("confirmed");
        pushLog({
          phase: "confirmed",
          message: "Rapport reçu par le DAO. Adresses gelées on-chain.",
          hash,
        });
        onFreezeAddresses?.();
        setReportOpen(true);
        toast.success("Adresses gelées on-chain", {
          description: `Tx ${hash.slice(0, 10)}… · réf. ${reportId}`,
        });
      },
      PHASE_DURATIONS.scanning +
        PHASE_DURATIONS.signing +
        PHASE_DURATIONS.broadcasting +
        PHASE_DURATIONS.confirming)
    );
  };

  const phaseSteps: Exclude<Phase, "idle">[] = [
    "scanning",
    "signing",
    "broadcasting",
    "confirming",
    "confirmed",
  ];
  const currentStepIndex = phase === "idle" ? -1 : phaseSteps.indexOf(phase);

  return (
    <aside className="flex h-full w-[350px] shrink-0 flex-col hairline-l bg-background">
      {/* Section 1 — Live Tracking */}
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
          <div className="flex items-center gap-2">
            {frozenCount > 0 && (
              <span className="border border-success bg-success px-2 py-1 font-mono text-[11px] font-bold tabular-nums text-background">
                ❄ {frozenCount}
              </span>
            )}
            <span className="border border-alert bg-alert px-2 py-1 font-mono text-[12px] font-bold tabular-nums text-background">
              {launderingCount.toLocaleString()}
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {txs.length === 0 && (
            <div className="px-6 py-6 font-mono text-[11px] text-ink-muted">
              En attente de transactions…
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
                  className={`group relative px-6 py-3 cursor-pointer outline-none transition-all border-l-2 border-transparent hover:border-l-foreground hover:bg-foreground/[0.06] focus-visible:border-l-foreground focus-visible:bg-foreground/[0.08] focus-visible:ring-1 focus-visible:ring-foreground/40 active:bg-foreground/10 ${
                    tx.laundering
                      ? "bg-alert-soft hover:border-l-alert focus-visible:border-l-alert"
                      : ""
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
                    <span
                      className={`${
                        tx.laundering ? "font-semibold text-alert" : "text-ink"
                      }`}
                    >
                      {tx.amount.toFixed(tx.amount >= 1 ? 2 : 4)} ETH
                    </span>
                  </div>
                  <div
                    className={`mt-1 flex items-center gap-2 font-mono text-[11px] ${
                      tx.laundering ? "text-alert" : "text-ink"
                    }`}
                  >
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

      {/* Section 1.5 — AI Backend Analysis (live mode) */}
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
              <span className="text-ink-muted">PATH_PREDICTION</span>
              <span className="text-ink">
                {pathPrediction?.prediction ?? "—"}
                {pathPrediction?.probability != null
                  ? ` · ${(pathPrediction.probability * 100).toFixed(0)}%`
                  : ""}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">TAINTED_WALLETS</span>
              <span className="text-ink">
                {analysis?.graph_summary?.tainted_count ?? "—"}
              </span>
            </div>
            <button
              onClick={() => setAiReportOpen(true)}
              disabled={!analysis?.narrative}
              className="w-full mt-2 border border-foreground py-2 font-mono text-[10px] uppercase tracking-[0.14em] hover:bg-foreground hover:text-background disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-foreground"
            >
              {analysis?.narrative ? "VIEW_INCIDENT_REPORT →" : "AWAITING_REPORT…"}
            </button>
          </div>
        </section>
      )}

      {/* Section 2 — Predictive Analysis */}
      <section className="hairline-t">
        <header className="flex items-center justify-between px-6 py-5 hairline-b">
          <h2 className="label-micro">PREDICTIVE_ANALYSIS</h2>
          <span className="label-micro">P(EXIT)</span>
        </header>
        <ul>
          {destinations.map((d) => {
            const isMixer = d.kind === "MIXER";
            return (
              <li key={d.name} className="px-6 py-3 hairline-b last:border-b-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`label-micro ${isMixer ? "text-alert" : ""}`}
                    >
                      {d.kind}
                    </span>
                    <span
                      className={`font-mono text-[11px] ${
                        isMixer ? "text-alert" : "text-ink"
                      }`}
                    >
                      {d.name}
                    </span>
                  </div>
                  <span
                    className={`font-mono text-[11px] ${
                      d.probability > 0.7
                        ? isMixer
                          ? "font-semibold text-alert"
                          : "font-semibold text-ink"
                        : "text-ink-muted"
                    }`}
                  >
                    {d.probability.toFixed(2)}
                  </span>
                </div>
                <div className="mt-2 h-px w-full bg-[hsl(var(--hairline))]">
                  <div
                    className={`h-px ${isMixer ? "bg-alert" : "bg-foreground"}`}
                    style={{ width: `${d.probability * 100}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Section 3 — DAO log */}
      {log.length > 0 && (
        <section className="hairline-t max-h-[180px] overflow-y-auto">
          <header className="sticky top-0 flex items-center justify-between bg-background px-6 py-3 hairline-b">
            <h2 className="label-micro">DAO_LOG / ON_CHAIN</h2>
            <span className="font-mono text-[10px] text-ink-muted">{log.length} EVT</span>
          </header>
          <ul>
            <AnimatePresence initial={false}>
              {log.map((e) => (
                <motion.li
                  key={e.id}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18 }}
                  className="px-6 py-2 hairline-b last:border-b-0"
                >
                  <div className="flex items-center justify-between font-mono text-[10px]">
                    <span className="text-ink-muted">{e.time}</span>
                    <span
                      className={`uppercase tracking-[0.12em] ${
                        e.phase === "confirmed" ? "text-alert font-semibold" : "text-ink"
                      }`}
                    >
                      {PHASE_LABEL[e.phase]}
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-ink">{e.message}</div>
                  {e.hash && (
                    <div className="mt-0.5 font-mono text-[10px] text-ink-muted">
                      tx {e.hash.slice(0, 10)}…{e.hash.slice(-6)}
                    </div>
                  )}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </section>
      )}

      {/* Section 4 — Action */}
      <section className="hairline-t p-6">
        {isRunning && (
          <div className="mb-3 space-y-2">
            <div className="flex items-center justify-between font-mono text-[10px]">
              <span className="uppercase tracking-[0.14em] text-ink">
                {PHASE_LABEL[phase as Exclude<Phase, "idle">]}
              </span>
              <span className="text-ink-muted">
                {currentStepIndex + 1}/{phaseSteps.length}
              </span>
            </div>
            <div className="flex gap-1">
              {phaseSteps.map((p, i) => (
                <div
                  key={p}
                  className={`h-0.5 flex-1 ${
                    i <= currentStepIndex ? "bg-foreground" : "bg-[hsl(var(--hairline))]"
                  } ${i === currentStepIndex ? "animate-pulse" : ""}`}
                />
              ))}
            </div>
          </div>
        )}
        <button
          onClick={handleBroadcast}
          disabled={isRunning || broadcasting}
          className={`group relative w-full overflow-hidden border py-4 font-mono text-[11px] uppercase tracking-[0.18em] transition-all hover:opacity-90 disabled:opacity-80 ${
            phase === "confirmed"
              ? "border-success bg-success text-background"
              : "border-foreground bg-foreground text-background"
          }`}
        >
          <span className="relative z-10">
            {phase === "idle" && "BROADCAST_REPORT_TO_DAO"}
            {phase === "scanning" && "SCAN_GRAPH…"}
            {phase === "signing" && "SIGNING_PAYLOAD…"}
            {phase === "broadcasting" && "BROADCASTING_TX…"}
            {phase === "confirming" && "AWAITING_CONFIRMATION…"}
            {phase === "confirmed" && "❄ FUNDS_FROZEN_ON_CHAIN ✓"}
          </span>
        </button>
        <p className="mt-3 font-mono text-[10px] leading-relaxed text-ink-muted">
          Soumet un rapport AML signé au DAO. Les validateurs voteront le gel
          on-chain de l'adresse suspecte. Action publique &amp; auditable.
        </p>
      </section>

      {/* Report dialog */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-w-lg border-success bg-background p-0">
          <DialogHeader className="hairline-b px-6 py-5">
            <div className="flex items-center justify-between">
              <DialogTitle className="label-micro text-foreground">
                AML_REPORT / FUNDS_FROZEN
              </DialogTitle>
              <span className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                <span className="label-micro text-success">ON_CHAIN_CONFIRMED</span>
              </span>
            </div>
          </DialogHeader>

          <div className="space-y-4 px-6 py-5">
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span className="text-ink-muted">REF</span>
              <span className="text-ink">{reportId}</span>
            </div>
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span className="text-ink-muted">TIMESTAMP</span>
              <span className="text-ink">{new Date().toISOString()}</span>
            </div>
            {currentTxHash && (
              <div className="flex items-start justify-between gap-3 font-mono text-[11px]">
                <span className="text-ink-muted shrink-0">FREEZE_TX_HASH</span>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(currentTxHash);
                    toast.success("Hash copié");
                  }}
                  className="text-success font-semibold underline-offset-2 hover:underline text-right break-all"
                  title="Copier le hash de la transaction de blocage"
                >
                  {currentTxHash.slice(0, 14)}…{currentTxHash.slice(-10)}
                </button>
              </div>
            )}
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span className="text-ink-muted">SUSPECT_ADDRESS</span>
              <span className="text-success font-semibold">
                {flaggedTx?.targetFull
                  ? `${flaggedTx.targetFull.slice(0, 10)}…${flaggedTx.targetFull.slice(-6)}`
                  : "0x—"}
              </span>
            </div>

            <div className="border border-success bg-success-soft p-4">
              <div className="label-micro text-success mb-2">❄ CONCLUSION</div>
              <p className="font-mono text-[12px] leading-relaxed text-ink">
                Les <span className="text-success font-semibold">{frozenCount} adresses</span> suspectes
                identifiées ont été <span className="text-success font-semibold">gelées on-chain</span>.
                Les fonds sont désormais inutilisables et ne peuvent plus être
                déplacés vers les CEX ni les bridges partenaires.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2 font-mono text-[10px]">
              <div className="hairline border p-2">
                <div className="text-ink-muted">FLAGGED_TX</div>
                <div className="text-ink text-[12px]">{launderingCount.toLocaleString()}</div>
              </div>
              <div className="hairline border p-2">
                <div className="text-ink-muted">FROZEN</div>
                <div className="text-success text-[12px] font-semibold">{frozenCount}</div>
              </div>
              <div className="hairline border p-2">
                <div className="text-ink-muted">STATUS</div>
                <div className="text-success text-[12px] font-semibold">RESOLVED</div>
              </div>
            </div>
          </div>

          <DialogFooter className="hairline-t px-6 py-4">
            <button
              onClick={() => setReportOpen(false)}
              className="w-full border border-success bg-success py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-background hover:opacity-90"
            >
              ACK_REPORT
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TxDetailDialog tx={selectedTx} onClose={() => setSelectedTx(null)} />

      {/* AI Incident Report dialog */}
      <Dialog open={aiReportOpen} onOpenChange={setAiReportOpen}>
        <DialogContent className="max-w-2xl border-foreground bg-background p-0">
          <DialogHeader className="hairline-b px-6 py-5">
            <div className="flex items-center justify-between">
              <DialogTitle className="label-micro text-foreground">
                AI_INCIDENT_REPORT / BACKEND
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
              <div className="font-mono text-[11px] text-ink-muted">
                {analysis.summary}
              </div>
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
