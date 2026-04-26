import type { PipelineStep } from "@/hooks/useBackendStream";

type Props = {
  liveVolume: number;
  liveCount: number;
  launderingCount: number;
  paused: boolean;
  onTogglePause: () => void;
  liveMode: boolean;
  onToggleLiveMode: () => void;
  backendConnected: boolean;
  pipelineStep: PipelineStep;
};

const STEP_LABEL: Record<PipelineStep, string> = {
  idle: "IDLE",
  building_graph: "BUILDING_GRAPH",
  path_prediction: "PATH_PREDICTION",
  generating_narrative: "NARRATIVE",
  complete: "COMPLETE",
};

export const Header = ({
  liveVolume,
  liveCount,
  launderingCount,
  paused,
  onTogglePause,
  liveMode,
  onToggleLiveMode,
  backendConnected,
  pipelineStep,
}: Props) => {
  const stats = [
    { label: "VOLUME_TRACKED", value: `${liveVolume.toFixed(2)} ETH` },
    { label: "TX_OBSERVED", value: liveCount.toLocaleString() },
    {
      label: "LAUNDERING_FLAGGED",
      value: launderingCount.toLocaleString(),
      alert: true,
    },
    {
      label: "NETWORK_STATUS",
      value: paused ? "PAUSED" : "ACTIVE",
      live: true,
      paused,
    },
  ];

  return (
    <header className="flex h-16 shrink-0 items-center justify-between px-6 hairline-b bg-background">
      <div className="flex items-center gap-3">
        <div className="h-2 w-2 bg-foreground" />
        <span className="font-mono text-[13px] font-medium tracking-[0.14em] text-ink">
          KOVER.IA
        </span>
        <span className="ml-3 label-micro">AML_OPS / v0.1</span>
      </div>
      <div className="flex items-center gap-10">
        {stats.map((s) => (
          <div key={s.label} className="flex flex-col items-end">
            <span className={`label-micro ${s.alert ? "text-alert" : ""}`}>
              {s.label}
            </span>
            <span
              className={`font-mono text-[13px] font-medium ${
                s.alert ? "text-alert" : "text-ink"
              }`}
            >
              {s.live ? (
                <span className="flex items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      s.paused ? "bg-ink-muted" : "bg-foreground animate-pulse"
                    }`}
                  />
                  {s.value}
                </span>
              ) : (
                s.value
              )}
            </span>
          </div>
        ))}
        <div className="flex flex-col items-end">
          <span className="label-micro">AI_PIPELINE</span>
          <span className="font-mono text-[13px] font-medium text-ink flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                liveMode && backendConnected
                  ? "bg-success animate-pulse"
                  : liveMode
                  ? "bg-alert animate-pulse"
                  : "bg-ink-muted"
              }`}
            />
            {liveMode ? STEP_LABEL[pipelineStep] : "DEMO"}
          </span>
        </div>
        <button
          onClick={async () => {
            try {
              const base = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8000";
              const r = await fetch(`${base}/launch/flashloan`, { method: "POST" });
              const data = await r.json().catch(() => ({}));
              const url = data.url ?? "http://localhost:8787";
              setTimeout(() => window.open(url, "_blank", "noopener,noreferrer"), 1200);
            } catch {
              window.open("http://localhost:8787", "_blank", "noopener,noreferrer");
            }
          }}
          title="Lance le dashboard de détection des flashloan attacks (kover-bfd-mev)"
          className="font-mono text-[10px] uppercase tracking-[0.14em] border px-3 py-1.5 transition-colors border-alert text-alert hover:bg-alert hover:text-background"
        >
          ⚡ DETECTE_HACK_FLASHLOAN
        </button>
        <button
          onClick={onToggleLiveMode}
          aria-pressed={liveMode}
          title={liveMode ? "Basculer en mode démo (mock seul)" : "Activer l'analyse IA temps réel"}
          className={`font-mono text-[10px] uppercase tracking-[0.14em] border px-3 py-1.5 transition-colors ${
            liveMode
              ? "border-success bg-success text-background hover:opacity-90"
              : "border-foreground text-foreground hover:bg-foreground hover:text-background"
          }`}
        >
          {liveMode ? "● LIVE_AI" : "○ DEMO_MODE"}
        </button>
        <button
          onClick={onTogglePause}
          aria-pressed={paused}
          title={paused ? "Reprendre le flux de transactions" : "Mettre en pause le flux de transactions"}
          className={`font-mono text-[10px] uppercase tracking-[0.14em] border px-3 py-1.5 transition-colors ${
            paused
              ? "border-foreground bg-foreground text-background hover:bg-background hover:text-foreground"
              : "border-foreground text-foreground hover:bg-foreground hover:text-background"
          }`}
        >
          {paused ? "▶ RESUME_STREAM" : "❚❚ PAUSE_STREAM"}
        </button>
      </div>
    </header>
  );
};
