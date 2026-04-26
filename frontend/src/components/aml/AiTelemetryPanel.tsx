import { useMemo } from "react";
import type {
  GatInference,
  LstmInference,
  CerebrasState,
  AiManifest,
} from "@/hooks/useBackendDataStream";
import { API_BASE } from "@/lib/api";

type Props = {
  manifest: AiManifest | null;
  gat: GatInference | null;
  lstm: LstmInference | null;
  cerebras: CerebrasState;
  inferenceCounts: Record<string, number>;
};

const truncSha = (s?: string | null) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "—");

const fmtMs = (n?: number | null) =>
  n == null ? "—" : n < 10 ? `${n.toFixed(2)}ms` : `${Math.round(n)}ms`;

const LSTM_CLASSES = ["Uniswap", "Binance", "Hyperliquid"];

export const AiTelemetryPanel = ({ manifest, gat, lstm, cerebras, inferenceCounts }: Props) => {
  const gatMeta = manifest?.manifest.models.gat;
  const lstmMeta = manifest?.manifest.models.lstm;
  const cerebrasMeta = manifest?.manifest.models.cerebras;

  const lstmBars = useMemo(() => {
    return LSTM_CLASSES.map((cls) => ({
      cls,
      p: lstm?.probabilities?.[cls] ?? 0,
      active: lstm?.prediction === cls,
    }));
  }, [lstm]);

  return (
    <section className="hairline-t bg-foreground/[0.03]">
      <header className="flex items-center justify-between px-6 py-3 hairline-b">
        <h2 className="label-micro">AI_TELEMETRY / PROVENANCE</h2>
        <a
          href={`${API_BASE}/ai/proof`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-muted hover:text-foreground underline-offset-2 hover:underline"
          title="Voir le manifest signé HMAC complet"
        >
          /ai/proof ↗
        </a>
      </header>

      <div className="space-y-3 px-6 py-3">
        {/* GAT card */}
        <div className="border border-foreground/30 p-3">
          <div className="flex items-center justify-between font-mono text-[11px]">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
              <span className="font-semibold">GAT</span>
              <span className="text-ink-muted">FraudGAT</span>
            </div>
            <span className="text-ink">{inferenceCounts.gat ?? 0} inferences</span>
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px] text-ink-muted">
            <div>SHA256 <span className="text-ink">{truncSha(gatMeta?.checkpoint_sha256)}</span></div>
            <div>params <span className="text-ink">{gatMeta?.param_count?.toLocaleString() ?? "—"}</span></div>
            <div>val_acc <span className="text-success">{gatMeta?.training_metrics?.val_accuracy ?? "—"}</span></div>
            <div>latency <span className="text-ink">{fmtMs(gat?.latency_ms)}</span></div>
            <div>nodes <span className="text-ink">{gat?.nodes_scored ?? "—"}</span></div>
            <div>max p(fraud) <span className={gat && gat.max_score > 0.7 ? "text-alert font-semibold" : "text-ink"}>{gat?.max_score?.toFixed(3) ?? "—"}</span></div>
          </div>
          {gat?.score_distribution && gat.score_distribution.length > 0 && (
            <div className="mt-2 flex h-3 items-end gap-[1px]">
              {gat.score_distribution.map((s, i) => (
                <div
                  key={i}
                  className={`flex-1 ${s > 0.7 ? "bg-alert" : "bg-foreground"}`}
                  style={{ height: `${Math.max(s * 100, 5)}%` }}
                  title={`top ${i + 1}: ${s.toFixed(3)}`}
                />
              ))}
            </div>
          )}
        </div>

        {/* LSTM card */}
        <div className="border border-foreground/30 p-3">
          <div className="flex items-center justify-between font-mono text-[11px]">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
              <span className="font-semibold">LSTM</span>
              <span className="text-ink-muted">PathLSTM</span>
            </div>
            <span className="text-ink">{inferenceCounts.lstm ?? 0} inferences</span>
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px] text-ink-muted">
            <div>SHA256 <span className="text-ink">{truncSha(lstmMeta?.checkpoint_sha256)}</span></div>
            <div>params <span className="text-ink">{lstmMeta?.param_count?.toLocaleString() ?? "—"}</span></div>
            <div>latency <span className="text-ink">{fmtMs(lstm?.latency_ms)}</span></div>
            <div>pred <span className="text-ink">{lstm?.prediction ?? "—"}</span></div>
          </div>
          <div className="mt-2 space-y-1">
            {lstmBars.map((b) => (
              <div key={b.cls} className="flex items-center gap-2 font-mono text-[9px]">
                <span className={`w-28 truncate ${b.active ? "text-foreground font-semibold" : "text-ink-muted"}`}>{b.cls}</span>
                <div className="flex-1 h-2 bg-[hsl(var(--hairline))]">
                  <div
                    className={`h-2 transition-all duration-500 ${b.active ? (b.cls === "Binance" || b.cls === "Hyperliquid" ? "bg-alert" : "bg-foreground") : "bg-foreground/40"}`}
                    style={{ width: `${(b.p * 100).toFixed(1)}%` }}
                  />
                </div>
                <span className={`w-12 text-right ${b.active ? "text-ink font-semibold" : "text-ink-muted"}`}>{(b.p * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>

        {/* Cerebras card */}
        <div className="border border-foreground/30 p-3">
          <div className="flex items-center justify-between font-mono text-[11px]">
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${cerebras.streaming ? "bg-alert animate-pulse" : "bg-success"}`} />
              <span className="font-semibold">Cerebras</span>
              <span className="text-ink-muted truncate max-w-[140px]">{cerebrasMeta?.model_id ?? cerebras.model_id}</span>
            </div>
            <span className="text-ink">{inferenceCounts.cerebras ?? 0} reports</span>
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px] text-ink-muted">
            <div>few-shot <span className="text-ink">{cerebrasMeta?.few_shot_examples ?? 0} ex.</span></div>
            <div>tokens <span className="text-ink">{cerebras.tokens}</span></div>
            <div>elapsed <span className="text-ink">{fmtMs(cerebras.elapsed_ms)}</span></div>
            <div>tok/s <span className="text-success">{cerebras.tokens_per_sec || 0}</span></div>
          </div>
          <div className="mt-2 max-h-32 overflow-y-auto bg-background border border-[hsl(var(--hairline))] p-2 font-mono text-[10px] leading-relaxed text-ink whitespace-pre-wrap">
            {cerebras.streaming ? (
              <>
                {cerebras.text}
                <span className="inline-block w-1 h-3 bg-alert animate-pulse ml-px" />
              </>
            ) : cerebras.last_complete_text ? (
              cerebras.last_complete_text
            ) : (
              <span className="text-ink-muted">en attente du prochain report (toutes les ~25s)…</span>
            )}
          </div>
        </div>

        {/* Signature footer */}
        {manifest && (
          <div className="font-mono text-[9px] text-ink-muted leading-tight pt-1 hairline-t">
            <div>HMAC-SHA256 manifest sig:</div>
            <div className="text-ink break-all">{manifest.signature_hmac_sha256.slice(0, 64)}…</div>
          </div>
        )}
      </div>
    </section>
  );
};
