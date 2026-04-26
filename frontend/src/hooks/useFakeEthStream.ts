// Fake ETH transaction stream — generates realistic-looking on-chain flow,
// flags some addresses as laundering (mixers / blacklisted clusters).

import { useEffect, useRef, useState } from "react";
import type { AmlNode, AmlLink } from "@/lib/aml-data";
import { computeScore, calculateCriticality } from "@/lib/aml-data";

export type StreamStatus = "open";

export type LiveTransaction = {
  hash: string;
  time: string;
  source: string;          // short
  target: string;          // short
  sourceFull: string;
  targetFull: string;
  amount: number;          // ETH
  laundering: boolean;
};

const MAX_TXS = 60;
const MAX_NODES = 70;   // keep the demo readable
const MAX_LINKS = 110;

// Known "bad" labels the simulator routes funds through
const LAUNDERING_LABELS = [
  "TORNADO_CASH",
  "RAILGUN",
  "SINBAD_MIXER",
];

// Legit destinations (hop 1)
const LEGIT_LABELS = [
  "BINANCE_HOT",
  "COINBASE",
  "GRANT_RECIPIENT",
];

const fmtTime = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const randHex = (len = 40) => {
  const chars = "0123456789abcdef";
  let s = "0x";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
};

const randTxHash = () => randHex(64);

// Single point of origin: the DAO vault
const DAO_ADDRESS = "0xda0" + "c0ffee".repeat(6).slice(0, 37);

type PoolWallet = { address: string; laundering: boolean; label?: string; hops: number };

function buildPool(): PoolWallet[] {
  const wallets: PoolWallet[] = [];
  // ► Single source of truth = DAO
  wallets.push({ address: DAO_ADDRESS, laundering: false, label: "DAO_VAULT", hops: 0 });
  // Legit recipients
  for (const label of LEGIT_LABELS) {
    wallets.push({ address: randHex(), laundering: false, label, hops: 1 });
  }
  // Laundering hubs
  for (const label of LAUNDERING_LABELS) {
    wallets.push({ address: randHex(), laundering: true, label, hops: 1 });
  }
  return wallets;
}

export function useFakeEthStream() {
  const [status] = useState<StreamStatus>("open");
  const [txs, setTxs] = useState<LiveTransaction[]>([]);
  const [nodes, setNodes] = useState<AmlNode[]>([]);
  const [links, setLinks] = useState<AmlLink[]>([]);
  const [stats, setStats] = useState({ volumeEth: 0, count: 0, launderingCount: 0 });
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const nodeMap = useRef<Map<string, AmlNode>>(new Map());
  const linkSet = useRef<Set<string>>(new Set());
  const velocityWindow = useRef<Map<string, number[]>>(new Map());
  const pool = useRef(buildPool());
  const tickCount = useRef(0);
  // Number of opening "safe-only" ticks before any laundering tx is allowed.
  const SAFE_WARMUP = 8;

  useEffect(() => {
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      if (pausedRef.current) {
        // While paused, just reschedule a check — no tx is generated.
        window.setTimeout(tick, 400);
        return;
      }

      const wallets = pool.current;
      const dao = wallets[0]; // DAO_VAULT is always index 0
      // Pool layout: [0]=DAO, [1..3]=legit hubs, [4..6]=laundering hubs
      const LEGIT_HUBS = [1, 2, 3];
      const LAUND_HUBS = [4, 5, 6];

      const safePhase = tickCount.current < SAFE_WARMUP;

      // ── Source selection ────────────────────────────────────────────
      let src: PoolWallet;
      if (safePhase) {
        // During warm-up, every tx originates from the DAO so the user
        // sees clean outbound flows first.
        src = dao;
      } else if (Math.random() < 0.5 || wallets.length < 8) {
        src = dao;
      } else {
        src = wallets[1 + Math.floor(Math.random() * (wallets.length - 1))];
        // If src is a laundering wallet during late warm-up, swap to DAO
        if (src.laundering && Math.random() < 0.4) src = dao;
      }

      // ── Target selection ────────────────────────────────────────────
      let tgt: PoolWallet;
      const r = Math.random();
      if (src === dao) {
        if (safePhase) {
          // Only legit hubs during warm-up
          tgt = wallets[LEGIT_HUBS[Math.floor(Math.random() * LEGIT_HUBS.length)]];
        } else if (r < 0.75) {
          // Mix of legit + laundering hubs after warm-up
          const allHubs = [...LEGIT_HUBS, ...LAUND_HUBS];
          tgt = wallets[allHubs[Math.floor(Math.random() * allHubs.length)]];
        } else {
          tgt = {
            address: randHex(),
            laundering: Math.random() < 0.15,
            hops: 1,
          };
          wallets.push(tgt);
        }
      } else {
        if (r < 0.7) {
          tgt = {
            address: randHex(),
            laundering: src.laundering && Math.random() < 0.7,
            hops: src.hops + 1,
          };
          wallets.push(tgt);
        } else {
          tgt = wallets[1 + Math.floor(Math.random() * (wallets.length - 1))];
          if (tgt.address === src.address) return;
        }
      }

      tickCount.current++;

      // Eviction so the pool stays small and readable
      if (wallets.length > MAX_NODES) {
        // never evict DAO (0) or hubs (1..6)
        wallets.splice(7, 1);
      }

      // Larger amounts when DAO is the source so the main flows pop visually
      const amount = +(
        (src.address === dao.address ? 5 + Math.random() * 25 : Math.random() * 4) + 0.05
      ).toFixed(4);
      const laundering = src.laundering || tgt.laundering;
      const now = Date.now();

      // Update velocity windows
      for (const a of [src.address, tgt.address]) {
        const arr = velocityWindow.current.get(a) ?? [];
        arr.push(now);
        const cutoff = now - 60_000;
        while (arr.length && arr[0] < cutoff) arr.shift();
        velocityWindow.current.set(a, arr);
      }

      const ensureNode = (
        addr: string,
        meta: { laundering: boolean; hops: number; label?: string }
      ): AmlNode => {
        const existing = nodeMap.current.get(addr);
        const velocity = velocityWindow.current.get(addr)?.length ?? 0;
        if (existing) {
          existing.velocity = velocity;
          existing.blacklisted = existing.blacklisted || meta.laundering;
          existing.score = computeScore(existing);
          existing.criticality = calculateCriticality({
            hopsFromSource: existing.hops,
            blacklisted: existing.blacklisted,
            hackFundsRatio: existing.hops <= 1 ? 0.95 : Math.random(),
            avgInOutSeconds: existing.blacklisted ? 30 + Math.random() * 90 : 60 + Math.random() * 600,
          });
          return existing;
        }
        const balance = +(0.5 + Math.random() * 200).toFixed(3);
        const base = {
          id: addr,
          address: addr,
          hops: meta.hops,
          velocity,
          blacklisted: meta.laundering,
          blacklistLinks: meta.laundering ? 1 : 0,
          label: meta.label,
          balance,
        };
        const criticality = calculateCriticality({
          hopsFromSource: meta.hops,
          blacklisted: meta.laundering,
          hackFundsRatio: meta.hops <= 1 ? 0.95 : Math.random(),
          avgInOutSeconds: meta.laundering ? 30 + Math.random() * 90 : 60 + Math.random() * 600,
        });
        const n: AmlNode = { ...base, score: computeScore(base), criticality };
        nodeMap.current.set(addr, n);
        return n;
      };

      ensureNode(src.address, { laundering: src.laundering, hops: src.hops, label: src.label });
      ensureNode(tgt.address, { laundering: tgt.laundering, hops: tgt.hops });

      // Eviction
      if (nodeMap.current.size > MAX_NODES) {
        const firstKey = nodeMap.current.keys().next().value;
        if (firstKey && firstKey !== src.address && firstKey !== tgt.address) {
          nodeMap.current.delete(firstKey);
        }
      }

      const linkKey = `${src.address}->${tgt.address}`;
      const isNewLink = !linkSet.current.has(linkKey);
      if (isNewLink) linkSet.current.add(linkKey);

      setNodes(Array.from(nodeMap.current.values()));
      if (isNewLink) {
        setLinks((prev) => {
          const next = [...prev, { source: src.address, target: tgt.address, amount }];
          return next.length > MAX_LINKS ? next.slice(next.length - MAX_LINKS) : next;
        });
      }

      const tx: LiveTransaction = {
        hash: randTxHash(),
        time: fmtTime(),
        source: short(src.address),
        target: short(tgt.address),
        sourceFull: src.address,
        targetFull: tgt.address,
        amount,
        laundering,
      };

      setTxs((prev) => [tx, ...prev].slice(0, MAX_TXS));
      setStats((s) => ({
        volumeEth: s.volumeEth + amount,
        count: s.count + 1,
        launderingCount: s.launderingCount + (laundering ? 1 : 0),
      }));

      // Schedule next tick — variable cadence for realism
      const delay = 350 + Math.random() * 900;
      window.setTimeout(tick, delay);
    };

    // Kickoff
    const t = window.setTimeout(tick, 200);
    return () => {
      stopped = true;
      window.clearTimeout(t);
    };
  }, []);

  return {
    status,
    txs,
    nodes,
    links,
    stats,
    paused,
    togglePause: () => setPaused((p) => !p),
    setPaused,
  };
}
