export type FilterMode = "all" | "laundering" | "high-score";

type Props = {
  value: FilterMode;
  onChange: (v: FilterMode) => void;
  counts: { all: number; laundering: number; highScore: number };
};

const options: { id: FilterMode; label: string; key: keyof Props["counts"] }[] = [
  { id: "all", label: "ALL", key: "all" },
  { id: "laundering", label: "LAUNDERING", key: "laundering" },
  { id: "high-score", label: "SCORE > 0.7", key: "highScore" },
];

export const FilterBar = ({ value, onChange, counts }: Props) => {
  return (
    <div className="flex items-center gap-px border hairline bg-background">
      {options.map((opt) => {
        const active = value === opt.id;
        const isAlert = opt.id === "laundering";
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            className={`flex items-center gap-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
              active
                ? isAlert
                  ? "bg-alert text-background"
                  : "bg-foreground text-background"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            <span>{opt.label}</span>
            <span
              className={`font-mono text-[10px] ${
                active ? "opacity-80" : "text-ink-faint"
              }`}
            >
              {counts[opt.key].toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
};
