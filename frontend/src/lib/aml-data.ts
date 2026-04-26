// KOVER.IA — AML data model + criticality engine
//
// Public interfaces (per spec):
//   WalletNode      — node-level metadata
//   TransactionLink — edge-level metadata
//
// Engine: calculateCriticality(walletNode) -> 0..100
//   P (Proximity) = 100 / (n + 1)
//   V (Velocity)  = +25 if avg time between in→out < 2 min
//   C (Concentration) = +20 if hackFunds / balance > 0.8
//   B (Blacklist) = if OFAC / Tornado-tagged => 100 (hard)
//   Score = min(100, P + V + C + B)

export interface WalletNode {
  id: string;            // 0x address
  criticality: number;   // 0..100
  balance: number;       // ETH
  isCEX: boolean;
  hopsFromSource: number;
}

export interface TransactionLink {
  source: string;
  target: string;
  amount: number;
  timestamp: string;
}

export type CriticalityInput = {
  hopsFromSource: number;
  avgInOutSeconds?: number;     // avg time between receiving and sending
  hackFundsRatio?: number;      // 0..1 (hack-derived / total balance)
  blacklisted?: boolean;        // OFAC / mixer / Tornado
};

export function calculateCriticality(w: CriticalityInput): number {
  if (w.blacklisted) return 100;
  const P = 100 / (w.hopsFromSource + 1);
  const V = w.avgInOutSeconds != null && w.avgInOutSeconds < 120 ? 25 : 0;
  const C = w.hackFundsRatio != null && w.hackFundsRatio > 0.8 ? 20 : 0;
  return Math.min(100, Math.round(P + V + C));
}

// ─────────────────────────────────────────────────────────────
// Internal graph types used by the dashboard / force-graph.
// `score` is normalized 0..1 (legacy); `criticality` is 0..100.
// ─────────────────────────────────────────────────────────────
export type AmlNode = {
  id: string;
  address: string;
  hops: number;          // alias of hopsFromSource for the simulator
  velocity: number;      // tx/min
  blacklisted: boolean;
  blacklistLinks: number;
  isSource?: boolean;
  isCex?: boolean;
  label?: string;
  score: number;         // 0..1
  criticality: number;   // 0..100
  balance: number;
};

export type AmlLink = {
  source: string;
  target: string;
  amount: number;
  timestamp?: string;
};

export type Transaction = {
  time: string;
  source: string;
  target: string;
  amount: number;
};

export type Destination = {
  name: string;
  kind: "CEX" | "BRIDGE" | "MIXER";
  probability: number;
};

const rand = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
};

const shortAddr = (i: number, r: () => number) => {
  const hex = "0123456789abcdef";
  let s = "0x";
  for (let k = 0; k < 40; k++) s += hex[Math.floor(r() * 16)];
  return s;
};

// Legacy 0..1 score retained for the existing visual sizing logic.
export function computeScore(n: Omit<AmlNode, "score" | "criticality" | "balance"> & { balance?: number }): number {
  const hopScore = Math.max(0, 1 - n.hops / 8);
  const velScore = Math.min(1, n.velocity / 30);
  const blScore = n.blacklisted ? 1 : Math.min(1, n.blacklistLinks / 5);
  const score = hopScore * 0.5 + velScore * 0.2 + blScore * 0.3;
  return Math.round(score * 100) / 100;
}

export function generateGraph(targetCount = 1000) {
  const r = rand(42);
  const nodes: AmlNode[] = [];
  const links: AmlLink[] = [];

  const mkNode = (
    base: Omit<AmlNode, "score" | "criticality" | "balance"> & { balance?: number; hackFundsRatio?: number; avgInOutSeconds?: number }
  ): AmlNode => {
    const balance = base.balance ?? +(0.5 + r() * 200).toFixed(3);
    const score = computeScore({ ...base, balance });
    const criticality = calculateCriticality({
      hopsFromSource: base.hops,
      blacklisted: base.blacklisted,
      hackFundsRatio: base.hackFundsRatio ?? (base.hops <= 1 ? 0.95 : r()),
      avgInOutSeconds: base.avgInOutSeconds ?? (base.blacklisted ? 30 + r() * 90 : 60 + r() * 600),
    });
    return { ...base, balance, score, criticality };
  };

  const source = mkNode({
    id: "src",
    address: "0xhack" + "deadbeef".repeat(4),
    hops: 0,
    velocity: 0,
    blacklisted: true,
    blacklistLinks: 0,
    isSource: true,
    label: "HACK_SOURCE",
    balance: 12000,
    hackFundsRatio: 1,
  });
  nodes.push(source);

  // Tier 1: 8 splitter wallets
  const tier1: AmlNode[] = [];
  for (let i = 0; i < 8; i++) {
    const node = mkNode({
      id: `t1-${i}`,
      address: shortAddr(i, r),
      hops: 1,
      velocity: 12 + r() * 18,
      blacklisted: r() > 0.6,
      blacklistLinks: Math.floor(r() * 4),
    });
    nodes.push(node);
    tier1.push(node);
    links.push({ source: "src", target: node.id, amount: 100 + r() * 900 });
  }

  // Tier 2: ~60 mixers
  const tier2: AmlNode[] = [];
  for (let i = 0; i < 60; i++) {
    const parent = tier1[Math.floor(r() * tier1.length)];
    const node = mkNode({
      id: `t2-${i}`,
      address: shortAddr(100 + i, r),
      hops: 2,
      velocity: 3 + r() * 15,
      blacklisted: r() > 0.85,
      blacklistLinks: Math.floor(r() * 3),
    });
    nodes.push(node);
    tier2.push(node);
    links.push({ source: parent.id, target: node.id, amount: 10 + r() * 200 });
  }

  // Tier 3: rest
  const remaining = targetCount - nodes.length;
  for (let i = 0; i < remaining; i++) {
    const parent = tier2[Math.floor(r() * tier2.length)];
    const hops = 3 + Math.floor(r() * 4);
    const node = mkNode({
      id: `t3-${i}`,
      address: shortAddr(1000 + i, r),
      hops,
      velocity: r() * 6,
      blacklisted: r() > 0.97,
      blacklistLinks: Math.floor(r() * 2),
    });
    nodes.push(node);
    links.push({ source: parent.id, target: node.id, amount: 0.5 + r() * 30 });
  }

  return { nodes, links };
}

export const destinations: Destination[] = [
  { name: "BINANCE_HOT_03", kind: "CEX", probability: 0.82 },
  { name: "WORMHOLE_BRIDGE", kind: "BRIDGE", probability: 0.71 },
  { name: "TORNADO_CASH", kind: "MIXER", probability: 0.64 },
  { name: "OKX_DEPOSIT_11", kind: "CEX", probability: 0.49 },
  { name: "RAILGUN", kind: "MIXER", probability: 0.37 },
  { name: "STARGATE_BRIDGE", kind: "BRIDGE", probability: 0.28 },
  { name: "KUCOIN_HOT_07", kind: "CEX", probability: 0.18 },
];

export function genTransaction(seed: number): Transaction {
  const r = rand(seed);
  const t = new Date(Date.now() - r() * 60000);
  const hh = String(t.getUTCHours()).padStart(2, "0");
  const mm = String(t.getUTCMinutes()).padStart(2, "0");
  const ss = String(t.getUTCSeconds()).padStart(2, "0");
  return {
    time: `${hh}:${mm}:${ss}`,
    source: shortAddr(seed, r).slice(0, 10),
    target: shortAddr(seed + 1, r).slice(0, 10),
    amount: Math.round(r() * 9800 + 200) / 10,
  };
}
