import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import type { LiveTransaction } from "@/hooks/useFakeEthStream";

type Props = {
  tx: LiveTransaction | null;
  onClose: () => void;
};

type Hop = {
  address: string;
  label: string;
  amount: number;
  kind: "MIXER" | "BRIDGE" | "WALLET" | "CEX";
};

const HOP_LABELS_BAD: Hop["label"][] = [
  "TORNADO_CASH",
  "RAILGUN",
  "SINBAD_MIXER",
  "WALLET_SHELL_01",
  "WALLET_SHELL_02",
  "BRIDGE_THORCHAIN",
  "EXIT_OTC_DESK",
];

const HOP_LABELS_OK: Hop["label"][] = [
  "BINANCE_HOT",
  "COINBASE",
  "GRANT_RECIPIENT",
  "DEV_PAYROLL",
];

const randHex = (len = 40) => {
  const chars = "0123456789abcdef";
  let s = "0x";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
};

const FALLBACK_HOP_LABEL = "UNKNOWN_HOP";

const classifyHop = (rawLabel: unknown): { label: string; kind: Hop["kind"] } => {
  const label =
    typeof rawLabel === "string" && rawLabel.length > 0
      ? rawLabel
      : FALLBACK_HOP_LABEL;
  const kind: Hop["kind"] =
    label.includes("MIXER") || label === "TORNADO_CASH" || label === "RAILGUN"
      ? "MIXER"
      : label.includes("BRIDGE")
      ? "BRIDGE"
      : label.includes("EXIT") || label.includes("BINANCE") || label.includes("COINBASE")
      ? "CEX"
      : "WALLET";
  return { label, kind };
};

const buildTrace = (tx: LiveTransaction): Hop[] => {
  const parsed = parseInt(tx.hash.slice(2, 10), 16);
  const seed = Number.isFinite(parsed) ? Math.abs(parsed) : 1;
  const rnd = (n: number) => ((seed >> (n * 3)) & 0xff) / 255;
  const pick = <T,>(pool: T[], i: number): T | undefined =>
    pool.length === 0 ? undefined : pool[((seed + i) % pool.length + pool.length) % pool.length];

  if (tx.laundering) {
    const count = 4;
    let remaining = tx.amount;
    const hops: Hop[] = [];
    for (let i = 0; i < count; i++) {
      const split = i === count - 1 ? remaining : remaining * (0.4 + rnd(i) * 0.4);
      remaining -= split;
      const { label, kind } = classifyHop(pick(HOP_LABELS_BAD, i));
      hops.push({
        address: randHex(),
        label,
        amount: +split.toFixed(4),
        kind,
      });
    }
    return hops;
  }

  // SAFE trace: 1 legit hop
  const { label, kind } = classifyHop(pick(HOP_LABELS_OK, 0));
  return [
    {
      address: randHex(),
      label,
      amount: tx.amount,
      kind,
    },
  ];
};

const BAD_VARIANTS: Array<{ title: string; summary: string; risks: string[] }> = [
  {
    title: "Schéma de layering via mixers",
    summary:
      "Les fonds traversent une chaîne de mixers anonymes (Tornado Cash → Railgun) avant d'être fragmentés sur plusieurs wallets-coquilles. Tentative claire de rompre la traçabilité on-chain avant un cash-out OTC.",
    risks: [
      "Origine liée à un cluster blacklisté",
      "Fragmentation rapide (smurfing) sur < 60s",
      "Passage par mixer non-conforme FATF",
      "Tentative de cash-out via OTC non-KYC",
    ],
  },
  {
    title: "Peel-chain vers bridge cross-chain",
    summary:
      "Le montant est progressivement « pelé » sur une suite de wallets éphémères puis transféré vers un bridge cross-chain (Thorchain). Schéma typique d'évasion vers une juridiction non coopérative.",
    risks: [
      "Wallets de transit créés < 24h avant la transaction",
      "Sortie vers bridge à faible KYC",
      "Vélocité anormale sur le segment final",
      "Convergence de fonds depuis 3 clusters sanctionnés",
    ],
  },
  {
    title: "Smurfing coordonné multi-wallets",
    summary:
      "Le flux est éclaté en micro-montants dispersés sur de nombreuses adresses puis recombiné en aval — signature classique d'un smurfing automatisé visant à passer sous les seuils de reporting AML.",
    risks: [
      "Fragmentation sous les seuils de déclaration",
      "Réagrégation détectée sur le même CEX",
      "Adresses contrôlées par un même cluster (heuristique commune-input)",
      "Patron temporel répétitif (bot-like)",
    ],
  },
  {
    title: "Exit OTC après obfuscation",
    summary:
      "Après plusieurs hops d'obfuscation, les fonds convergent vers un OTC desk connu pour son absence de KYC strict. Le verdict est sans ambiguïté : sortie illicite en préparation.",
    risks: [
      "Destinataire final flaggé OFAC-adjacent",
      "Aucune contrepartie commerciale identifiable",
      "Schéma déjà observé dans 4 cas confirmés",
      "Trace on-chain volontairement bruitée",
    ],
  },
];

const SAFE_VARIANTS: Array<{ title: string; summary: string; risks: string[] }> = [
  {
    title: "Versement à un bénéficiaire de grant",
    summary:
      "Sortie du DAO_VAULT vers un bénéficiaire de grant identifié dans le registre public. Aucun signal de mixer, vélocité conforme, contrepartie KYC.",
    risks: [
      "Destinataire identifié & KYC vérifié",
      "Vélocité dans les seuils normaux",
      "Aucun hop vers un cluster sanctionné",
    ],
  },
  {
    title: "Paiement de rémunération dev",
    summary:
      "Transaction récurrente vers une adresse de payroll connue. Pattern stable sur les 6 derniers mois, montant cohérent avec l'historique.",
    risks: [
      "Adresse récurrente whitelistée",
      "Montant aligné sur l'historique",
      "Aucun lien avec un cluster à risque",
    ],
  },
  {
    title: "Dépôt sur CEX KYC conforme",
    summary:
      "Transfert direct vers un hot wallet d'exchange régulé (Binance / Coinbase). Pas d'étape d'obfuscation, traçabilité préservée.",
    risks: [
      "Destinataire CEX régulé",
      "Aucune fragmentation détectée",
      "Métriques de risque sous les seuils",
    ],
  },
];

const explainTx = (tx: LiveTransaction) => {
  const parsed = parseInt(tx.hash.slice(2, 10), 16);
  const seed = Number.isFinite(parsed) ? Math.abs(parsed) : 0;
  if (tx.laundering) {
    const v = BAD_VARIANTS[seed % BAD_VARIANTS.length];
    return { ...v, verdict: "UNSAFE" as const };
  }
  const v = SAFE_VARIANTS[seed % SAFE_VARIANTS.length];
  return { ...v, verdict: "SAFE" as const };
};

export const TxDetailDialog = ({ tx, onClose }: Props) => {
  const [revealedHops, setRevealedHops] = useState(0);
  const [revealedTimeline, setRevealedTimeline] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [view, setView] = useState<"hops" | "timeline">("hops");
  const revealed = view === "hops" ? revealedHops : revealedTimeline;
  const setRevealed = (n: number) => {
    if (view === "hops") setRevealedHops(n);
    else setRevealedTimeline(n);
  };

  const trace = useMemo(() => (tx ? buildTrace(tx) : []), [tx]);
  const explanation = useMemo(() => (tx ? explainTx(tx) : null), [tx]);

  // Timeline: chained source → target steps with synthetic timestamps,
  // starting from the original tx time and incrementing per hop.
  const timeline = useMemo(() => {
    if (!tx) return [] as Array<{ time: string; from: string; to: string; amount: number; kind: Hop["kind"]; bad: boolean }>;
    const [hh, mm, ss] = tx.time.split(":").map((n) => parseInt(n, 10));
    let total = (hh || 0) * 3600 + (mm || 0) * 60 + (ss || 0);
    const fmt = (sec: number) => {
      const s = ((sec % 86400) + 86400) % 86400;
      const p = (n: number) => String(n).padStart(2, "0");
      return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
    };
    let prev = tx.sourceFull;
    return trace.map((hop, i) => {
      total += 12 + (i * 7) % 23; // 12–34s between hops
      const step = {
        time: fmt(total),
        from: prev,
        to: hop.address,
        amount: hop.amount,
        kind: hop.kind,
        bad: tx.laundering,
        label: hop.label,
      } as const;
      prev = hop.address;
      return step;
    });
  }, [tx, trace]);

  useEffect(() => {
    if (!tx) return;
    setRevealedHops(0);
    setRevealedTimeline(0);
    setBlocked(false);
    let i = 0;
    const id = window.setInterval(() => {
      i++;
      if (view === "hops") setRevealedHops(i);
      else setRevealedTimeline(i);
      if (i >= trace.length) {
        window.clearInterval(id);
        if (tx.laundering) {
          window.setTimeout(() => setBlocked(true), 600);
        }
      }
    }, 450);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx, trace.length]);

  if (!tx || !explanation) return null;

  const isBad = tx.laundering;

  return (
    <AnimatePresence>
      {tx && (
        <motion.aside
          key="tx-detail"
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          role="dialog"
          aria-label="Transaction investigation"
          className="fixed top-[72px] bottom-4 right-[362px] z-40 w-[400px] max-w-[calc(100vw-380px)] flex flex-col border border-foreground bg-background shadow-[0_8px_40px_-8px_rgba(0,0,0,0.25)]"
        >
          <header className="hairline-b px-5 py-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className={`h-1.5 w-1.5 rounded-full animate-pulse ${
                  isBad ? "bg-alert" : "bg-foreground"
                }`}
              />
              <span
                className={`label-micro ${
                  isBad ? "text-alert" : "text-foreground"
                }`}
              >
                {isBad ? "AML_INVESTIGATION / UNSAFE" : "AML_INVESTIGATION / SAFE"}
              </span>
            </div>
            <button
              onClick={onClose}
              aria-label="Fermer"
              title="Fermer"
              className="flex h-7 w-7 items-center justify-center border border-foreground bg-background text-foreground transition-colors hover:bg-foreground hover:text-background"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          </header>

          <div className="space-y-4 px-5 py-4 overflow-y-auto flex-1">
            {/* Header tx */}
            <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
              <div className="hairline border p-2">
                <div className="text-ink-muted label-micro">FROM</div>
                <div className="text-ink mt-1 break-all">{tx.source}</div>
              </div>
              <div className="hairline border p-2">
                <div className="text-ink-muted label-micro">TO</div>
                <div className={`mt-1 break-all ${isBad ? "text-alert font-semibold" : "text-ink"}`}>
                  {tx.target}
                </div>
              </div>
              <div className="hairline border p-2">
                <div className="text-ink-muted label-micro">AMOUNT</div>
                <div className="text-ink mt-1 text-[13px] font-semibold">
                  {tx.amount.toFixed(4)} ETH
                </div>
              </div>
              <div className="hairline border p-2">
                <div className="text-ink-muted label-micro">TIME</div>
                <div className="text-ink mt-1">{tx.time} UTC</div>
              </div>
            </div>

            {/* Explication */}
            <div
              className={`hairline border p-3 ${
                isBad ? "bg-alert-soft" : ""
              }`}
            >
              <div
                className={`label-micro mb-2 ${
                  isBad ? "text-alert" : "text-foreground"
                }`}
              >
                {explanation.title}
              </div>
              <p className="font-mono text-[12px] leading-relaxed text-ink">
                {explanation.summary}
              </p>
              <ul className="mt-3 space-y-1">
                {explanation.risks.map((r) => (
                  <li
                    key={r}
                    className="font-mono text-[11px] text-ink flex items-start gap-2"
                  >
                    <span
                      className={isBad ? "text-alert" : "text-foreground"}
                    >
                      {isBad ? "▲" : "✓"}
                    </span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Trace — tabbed view: HOPS vs TIMELINE */}
            <div>
              <div className="flex items-center justify-between mb-2 gap-2">
                <div role="tablist" aria-label="Vue du trace" className="flex">
                  {(["hops", "timeline"] as const).map((v) => {
                    const active = view === v;
                    return (
                      <button
                        key={v}
                        role="tab"
                        aria-selected={active}
                        onClick={() => setView(v)}
                        className={`font-mono text-[10px] uppercase tracking-[0.14em] border px-2 py-1 -ml-px first:ml-0 transition-colors ${
                          active
                            ? isBad
                              ? "border-alert bg-alert text-background"
                              : "border-foreground bg-foreground text-background"
                            : "border-foreground/40 text-ink-muted hover:text-foreground hover:border-foreground"
                        }`}
                      >
                        {v === "hops"
                          ? isBad
                            ? "MONEY_TRAIL"
                            : "ROUTE"
                          : "TIMELINE"}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-ink-muted">
                    {revealed}/{trace.length} HOPS
                  </span>
                  {revealed < trace.length && (
                    <button
                      onClick={() => {
                        setRevealed(trace.length);
                        if (isBad) setBlocked(true);
                      }}
                      className={`font-mono text-[10px] uppercase tracking-[0.14em] border px-2 py-1 transition-colors ${
                        isBad
                          ? "border-alert text-alert hover:bg-alert hover:text-background"
                          : "border-foreground text-foreground hover:bg-foreground hover:text-background"
                      }`}
                      title="Afficher tout le chemin des fonds"
                    >
                      REVEAL_FULL_TRAIL →
                    </button>
                  )}
                </div>
              </div>

              {view === "hops" ? (
                <ol className="space-y-2">
                  {trace.map((hop, i) => {
                    const visible = i < revealed;
                    const bad = isBad;
                    return (
                      <li
                        key={i}
                        className={`hairline border p-2.5 transition-opacity duration-300 ${
                          visible ? "opacity-100" : "opacity-20"
                        } ${bad ? "bg-alert-soft" : ""}`}
                      >
                        <div className="flex items-center justify-between font-mono text-[11px]">
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`label-micro shrink-0 ${
                                bad ? "text-alert" : "text-foreground"
                              }`}
                            >
                              HOP {i + 1} · {hop.kind}
                            </span>
                            <span
                              className={`text-[11px] truncate ${
                                bad ? "text-alert font-semibold" : "text-ink"
                              }`}
                            >
                              {hop.label}
                            </span>
                          </div>
                          <span className="text-ink tabular-nums shrink-0">
                            {hop.amount.toFixed(4)} ETH
                          </span>
                        </div>
                        <div className="mt-1 font-mono text-[10px] text-ink-muted break-all">
                          {hop.address.slice(0, 14)}…{hop.address.slice(-10)}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <div className="hairline border overflow-hidden">
                  <div className="grid grid-cols-[68px_1fr_84px] gap-2 px-2.5 py-1.5 bg-foreground/[0.04] hairline-b">
                    <span className="label-micro">TIME</span>
                    <span className="label-micro">SOURCE → TARGET</span>
                    <span className="label-micro text-right">AMOUNT</span>
                  </div>
                  <ol>
                    {timeline.map((step, i) => {
                      const visible = i < revealed;
                      return (
                        <li
                          key={i}
                          className={`grid grid-cols-[68px_1fr_84px] gap-2 px-2.5 py-2 hairline-b last:border-b-0 transition-opacity duration-300 ${
                            visible ? "opacity-100" : "opacity-20"
                          } ${step.bad ? "bg-alert-soft" : ""}`}
                        >
                          <span className="font-mono text-[10px] text-ink-muted tabular-nums">
                            {step.time}
                          </span>
                          <div className="min-w-0 font-mono text-[10px]">
                            <div className="text-ink-muted truncate">
                              {step.from.slice(0, 8)}…{step.from.slice(-4)}
                            </div>
                            <div
                              className={`flex items-center gap-1 truncate ${
                                step.bad ? "text-alert" : "text-ink"
                              }`}
                            >
                              <span className="shrink-0">↓</span>
                              <span className="truncate">
                                {step.to.slice(0, 8)}…{step.to.slice(-4)}
                              </span>
                              <span
                                className={`ml-1 label-micro shrink-0 ${
                                  step.bad ? "text-alert" : "text-foreground"
                                }`}
                              >
                                · {step.kind}
                              </span>
                            </div>
                          </div>
                          <span
                            className={`text-right font-mono text-[11px] tabular-nums ${
                              step.bad ? "text-alert font-semibold" : "text-ink"
                            }`}
                          >
                            {step.amount.toFixed(4)}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              )}
            </div>

            {/* Verdict final */}
            {isBad && blocked && (
              <div className="hairline border-2 border-alert bg-alert text-background p-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="label-micro mb-1">ACTION_EXÉCUTÉE</div>
                <div className="font-mono text-[13px] font-bold uppercase tracking-[0.1em]">
                  ✕ ADRESSE BLOQUÉE
                </div>
                <div className="font-mono text-[11px] mt-2 leading-relaxed opacity-90 break-all">
                  {tx.targetFull} a été ajoutée à la liste noire AML. Toute
                  transaction sortante depuis ou vers cette adresse sera
                  automatiquement rejetée par les CEX et bridges partenaires.
                </div>
              </div>
            )}

            {!isBad && revealed >= trace.length && (
              <div className="hairline border border-foreground p-3">
                <div className="label-micro mb-1 text-foreground">
                  AUCUNE_ACTION_REQUISE
                </div>
                <div className="font-mono text-[12px] text-ink leading-relaxed">
                  Transaction validée. Le destinataire est conforme et aucun
                  signal AML n'a été déclenché.
                </div>
              </div>
            )}
          </div>

          <footer className="hairline-t px-5 py-3">
            <button
              onClick={onClose}
              className="w-full font-mono text-[11px] uppercase tracking-[0.16em] border border-foreground px-4 py-2 hover:bg-foreground hover:text-background transition-colors"
            >
              FERMER
            </button>
          </footer>
        </motion.aside>
      )}
    </AnimatePresence>
  );
};
