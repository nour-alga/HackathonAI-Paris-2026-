import { useEffect, useState } from "react";

type Props = {
  hash: string;
  laundering: boolean;
};

// Animated AML risk score:
// - ~1.4s : oscille entre 0 et 1 (analyse en cours)
// - puis se fige sur le score final
export const TxScore = ({ hash, laundering }: Props) => {
  const [score, setScore] = useState(0);
  const [analyzing, setAnalyzing] = useState(true);

  useEffect(() => {
    setAnalyzing(true);
    let raf = 0;
    const start = performance.now();
    const DURATION = 1400;

    const seed = parseInt(hash.slice(2, 10), 16) / 0xffffffff;
    let finalScore: number;
    if (laundering) {
      finalScore = 0.85 + seed * 0.15;
    } else if (seed < 0.18) {
      finalScore = 0.3 + seed * 2;
    } else {
      finalScore = seed * 0.15;
    }
    finalScore = Math.min(1, Math.max(0, finalScore));

    const loop = (t: number) => {
      const elapsed = t - start;
      if (elapsed < DURATION) {
        const noise =
          0.5 +
          0.45 *
            Math.sin(elapsed * 0.018 + seed * 10) *
            Math.cos(elapsed * 0.011 + seed * 4);
        setScore(Math.min(1, Math.max(0, noise)));
        raf = requestAnimationFrame(loop);
      } else {
        setScore(finalScore);
        setAnalyzing(false);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [hash, laundering]);

  const verdict = analyzing
    ? "ANALYZING"
    : score >= 0.7
    ? "UNSAFE"
    : score >= 0.3
    ? "REVIEW"
    : "SAFE";

  const isUnsafe = !analyzing && verdict === "UNSAFE";
  const isReview = !analyzing && verdict === "REVIEW";

  const tone = analyzing
    ? "text-ink"
    : isUnsafe
    ? "text-alert"
    : isReview
    ? "text-foreground"
    : "text-foreground/70";

  const barColor = analyzing
    ? "bg-ink"
    : isUnsafe
    ? "bg-alert"
    : isReview
    ? "bg-foreground"
    : "bg-foreground/50";

  return (
    <div className="mt-1.5 w-full">
      <div className="flex items-center justify-between font-mono leading-none">
        <span className="label-micro text-foreground/80 text-[10px]">
          AML_SCORE
        </span>
        <span className={`tabular-nums font-bold text-[13px] ${tone}`}>
          {score.toFixed(2)}
          <span className="ml-2 text-[10px] font-semibold tracking-[0.12em]">
            · {verdict}
          </span>
          {analyzing && <span className="ml-1 animate-pulse">▍</span>}
        </span>
      </div>
      <div className="mt-1.5 h-[6px] w-full bg-[hsl(var(--hairline))] overflow-hidden border border-foreground/10">
        <div
          className={`h-full ${barColor} ${
            analyzing ? "transition-none" : "transition-[width] duration-300"
          }`}
          style={{ width: `${score * 100}%` }}
        />
      </div>
    </div>
  );
};
