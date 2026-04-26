import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { ForceGraphMethods } from "react-force-graph-2d";
import { forceX, forceY } from "d3-force";
import type { AmlNode, AmlLink } from "@/lib/aml-data";

type Props = {
  nodes: AmlNode[];
  links: AmlLink[];
  scanning: boolean;
  onInspectNode?: (node: AmlNode) => void;
  onInspectLink?: (link: AmlLink) => void;
  frozenAddresses?: Set<string>;
};

const ALERT_RGB = "239, 68, 68"; // hsl(0 84% 50%)
const SUCCESS_RGB = "37, 147, 92"; // hsl(152 60% 36%) — frozen / safe

export const ForceGraph = ({ nodes, links, scanning, onInspectNode, onInspectLink, frozenAddresses }: Props) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<{ x: number; y: number; node: AmlNode } | null>(null);
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  const [autoDeclutter, setAutoDeclutter] = useState(true);

  // ── Peel-chain layout: max amount drives the "main flow" thickness ──────
  const maxAmount = useMemo(
    () => links.reduce((m, l) => Math.max(m, l.amount), 0) || 1,
    [links]
  );

  // Build ancestor index: for any link, walk back to source via incoming links
  const incomingByTarget = useMemo(() => {
    const map = new Map<string, AmlLink[]>();
    for (const l of links) {
      const tId = typeof (l as any).target === "object" ? (l as any).target.id : l.target;
      const arr = map.get(tId) ?? [];
      arr.push(l);
      map.set(tId, arr);
    }
    return map;
  }, [links]);

  // Resolve the ancestor path (set of link keys + node ids) for a given link
  const highlight = useMemo(() => {
    if (!selectedLink) return null;
    const linkKeys = new Set<string>([selectedLink]);
    const nodeIds = new Set<string>();
    const [s0, t0] = selectedLink.split("→");
    nodeIds.add(s0);
    nodeIds.add(t0);
    let frontier: string[] = [s0];
    const visited = new Set<string>([s0]);
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        const incoming = incomingByTarget.get(id) ?? [];
        for (const l of incoming) {
          const sId = typeof (l as any).source === "object" ? (l as any).source.id : l.source;
          const key = `${sId}→${id}`;
          linkKeys.add(key);
          nodeIds.add(sId);
          if (!visited.has(sId)) {
            visited.add(sId);
            next.push(sId);
          }
        }
      }
      frontier = next;
    }
    return { linkKeys, nodeIds };
  }, [selectedLink, incomingByTarget]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Forces: peel-chain layout from DAO (left) → recipients (right)
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force("charge")?.strength(-90);
    fg.d3Force("link")?.distance(70);
    const colW = Math.max(140, size.w / 7);
    fg.d3Force(
      "x",
      forceX((n: any) => (n.hops ?? 0) * colW - size.w / 2 + colW).strength(
        (n: any) => (n.isSource || n.label === "DAO_VAULT" ? 1 : 0.45)
      ) as any
    );
    fg.d3Force("y", forceY(0).strength(0.06) as any);
    fg.d3ReheatSimulation();
  }, [size.w]);

  const data = { nodes: nodes as any, links: links as any };

  const linkKeyOf = (l: any) => {
    const sId = typeof l.source === "object" ? l.source.id : l.source;
    const tId = typeof l.target === "object" ? l.target.id : l.target;
    return `${sId}→${tId}`;
  };

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-background">
      <ForceGraph2D
        ref={fgRef as any}
        graphData={data}
        width={size.w}
        height={size.h}
        backgroundColor="#FFFFFF"
        nodeRelSize={1}
        cooldownTicks={140}
        warmupTicks={40}
        d3AlphaDecay={0.035}
        enableNodeDrag={false}
        linkColor={(l: any) => {
          const key = linkKeyOf(l);
          const dim = highlight && !highlight.linkKeys.has(key);
          if (dim) return "rgba(0,0,0,0.06)";
          const t = typeof l.target === "object" ? l.target : null;
          const s = typeof l.source === "object" ? l.source : null;
          const sFrozen = !!(s && frozenAddresses?.has(s.id));
          const tFrozen = !!(t && frozenAddresses?.has(t.id));
          const frozen = sFrozen || tFrozen;
          const bad = (t && t.blacklisted) || (s && s.blacklisted);
          if (frozen) {
            return highlight && highlight.linkKeys.has(key)
              ? `rgba(${SUCCESS_RGB},0.95)`
              : `rgba(${SUCCESS_RGB},0.55)`;
          }
          if (highlight && highlight.linkKeys.has(key)) {
            return bad ? `rgba(${ALERT_RGB},0.95)` : "rgba(0,0,0,0.85)";
          }
          return bad ? `rgba(${ALERT_RGB},0.45)` : "rgba(0,0,0,0.18)";
        }}
        linkWidth={(l: any) => {
          const ratio = l.amount / maxAmount;
          // > 50% of butin → 2px solid
          if (ratio > 0.5) return 2;
          // proportional, micro-tx ≥ 0.5
          return Math.max(0.5, ratio * 1.8);
        }}
        linkHoverPrecision={12}
        onRenderFramePost={(ctx, scale) => {
          // ── AUTO_DECLUTTER: density + format adapt to current zoom ─────
          const tier = !autoDeclutter ? 2 : scale < 1.0 ? 0 : scale < 1.8 ? 1 : 2;

          // ── SPATIAL GRID for true overlap rejection ────────────────────
          // Uniform grid keyed by integer (cellX, cellY). Each cell holds
          // the list of AABBs that intersect it. Query/insert are O(k)
          // where k = #rects in the touched cells (typically 0–4), instead
          // of O(N) for the previous naive scan.
          type AABB = { x1: number; y1: number; x2: number; y2: number };
          const CELL = 24 / scale; // graph-space cell size; ~label height
          const grid = new Map<string, AABB[]>();
          const cellKey = (cx: number, cy: number) => `${cx}|${cy}`;
          const cellsOf = (b: AABB) => {
            const cx1 = Math.floor(b.x1 / CELL);
            const cy1 = Math.floor(b.y1 / CELL);
            const cx2 = Math.floor(b.x2 / CELL);
            const cy2 = Math.floor(b.y2 / CELL);
            const out: string[] = [];
            for (let cx = cx1; cx <= cx2; cx++)
              for (let cy = cy1; cy <= cy2; cy++) out.push(cellKey(cx, cy));
            return out;
          };
          const collides = (b: AABB) => {
            for (const k of cellsOf(b)) {
              const bucket = grid.get(k);
              if (!bucket) continue;
              for (const p of bucket) {
                if (!(b.x2 < p.x1 || b.x1 > p.x2 || b.y2 < p.y1 || b.y1 > p.y2)) {
                  return true;
                }
              }
            }
            return false;
          };
          const insert = (b: AABB) => {
            for (const k of cellsOf(b)) {
              let bucket = grid.get(k);
              if (!bucket) {
                bucket = [];
                grid.set(k, bucket);
              }
              bucket.push(b);
            }
          };

          // Seed the grid with node footprints + hub-label boxes so that
          // address labels never sit on top of them.
          for (const n of data.nodes as any[]) {
            if (n.x == null || n.y == null) continue;
            const isDao = n.label === "DAO_VAULT" || n.isSource;
            const r = (isDao ? 8 : n.blacklisted ? 4.5 : n.label ? 4 : 2.4) + 2;
            insert({ x1: n.x - r, y1: n.y - r, x2: n.x + r, y2: n.y + r });
            if (n.label) {
              // approx hub label box (matches nodeCanvasObject layout)
              const fs = isDao ? 12 : 10;
              const w = ctx.measureText(n.label).width + 8;
              const h = fs + 6;
              const cy = n.y - r - 8 - h / 2;
              insert({ x1: n.x - w / 2, y1: cy - h / 2, x2: n.x + w / 2, y2: cy + h / 2 });
            }
          }

          const fontSize = Math.max(7.5, (tier === 0 ? 9 : 10) / Math.sqrt(scale));
          ctx.font = `600 ${fontSize}px JetBrains Mono, monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const padX = 5;
          const padY = 4;
          const baseOffset = 14 / scale;

          // Sort: most important first (priority for placement)
          const sorted = [...(data.links as any[])].sort((a, b) => b.amount - a.amount);

          for (const l of sorted) {
            const s = typeof l.source === "object" ? l.source : null;
            const t = typeof l.target === "object" ? l.target : null;
            if (!s || !t || s.x == null || t.x == null) continue;

            const key = linkKeyOf(l);
            const dim = highlight && !highlight.linkKeys.has(key);
            if (dim) continue;

            const ratio = l.amount / maxAmount;
            const isHighlighted = !!(highlight && highlight.linkKeys.has(key));
            const bad = !!(t.blacklisted || s.blacklisted);
            const isHubEdge = !!(s.label || t.label);

            // Per-tier allow-list (controls "candidate" pool, not collision)
            let allowLabel: boolean;
            if (tier === 0) {
              allowLabel = isHighlighted || (isHubEdge && ratio > 0.4) || ratio > 0.55;
            } else if (tier === 1) {
              allowLabel = isHighlighted || isHubEdge || (bad && ratio > 0.3) || ratio > 0.3;
            } else {
              allowLabel =
                isHighlighted || isHubEdge || (bad && ratio > 0.15) || ratio > 0.12;
            }
            if (!allowLabel) continue;

            const dx = t.x - s.x;
            const dy = t.y - s.y;
            const len = Math.hypot(dx, dy);
            if (len < 40) continue;

            const nx = -dy / len;
            const ny = dx / len;

            const addr = t.address ?? t.id;
            const lbl =
              tier === 0
                ? `${addr.slice(0, 5)}…`
                : tier === 1
                  ? `${addr.slice(0, 6)}…${addr.slice(-3)}`
                  : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
            const w = ctx.measureText(lbl).width;
            const boxW = w + padX * 2;
            const boxH = fontSize + padY * 2;

            // Try several positions along the line (0.35 → 0.7) on both
            // sides, increasing perpendicular offset until grid says OK.
            const tParams = [0.55, 0.45, 0.65, 0.35, 0.7];
            const offsetMults = [1, 1.6, 2.2, 3, 4];
            let placedBox: AABB | null = null;
            let lx = 0;
            let ly = 0;
            let ax = 0;
            let ay = 0;

            search: for (const tp of tParams) {
              const px = s.x + dx * tp;
              const py = s.y + dy * tp;
              for (const mult of offsetMults) {
                for (const sign of [1, -1]) {
                  const cx = px + nx * baseOffset * mult * sign;
                  const cy = py + ny * baseOffset * mult * sign;
                  const box: AABB = {
                    x1: cx - boxW / 2,
                    y1: cy - boxH / 2,
                    x2: cx + boxW / 2,
                    y2: cy + boxH / 2,
                  };
                  if (!collides(box)) {
                    placedBox = box;
                    lx = cx;
                    ly = cy;
                    ax = px;
                    ay = py;
                    break search;
                  }
                }
              }
            }

            if (!placedBox) continue; // overlap unavoidable → skip
            insert(placedBox);

            // Leader line — clamp endpoint to the box border using
            // segment ↔ AABB intersection so the line never enters the box.
            const ldx = lx - ax;
            const ldy = ly - ay;
            const halfW = boxW / 2;
            const halfH = boxH / 2;
            // Slab method: find smallest positive t in [0,1] where the
            // segment from (ax,ay) → (lx,ly) crosses the box border.
            let tEnter = 1;
            if (ldx !== 0) {
              const tx1 = (lx - halfW - ax) / ldx;
              const tx2 = (lx + halfW - ax) / ldx;
              for (const tc of [tx1, tx2]) {
                if (tc > 0 && tc < tEnter) {
                  const yAt = ay + ldy * tc;
                  if (yAt >= ly - halfH && yAt <= ly + halfH) tEnter = tc;
                }
              }
            }
            if (ldy !== 0) {
              const ty1 = (ly - halfH - ay) / ldy;
              const ty2 = (ly + halfH - ay) / ldy;
              for (const tc of [ty1, ty2]) {
                if (tc > 0 && tc < tEnter) {
                  const xAt = ax + ldx * tc;
                  if (xAt >= lx - halfW && xAt <= lx + halfW) tEnter = tc;
                }
              }
            }
            // Pull the endpoint a hair back so the stroke doesn't kiss the border edge
            const tStop = Math.max(0, tEnter - 0.5 / Math.hypot(ldx, ldy));
            const ex = ax + ldx * tStop;
            const ey = ay + ldy * tStop;

            // Monochrome leader line — critical links get full ink, legit links stay subtle.
            // Anchor dot on the trajectory (always black, sized by criticality)
            ctx.beginPath();
            ctx.fillStyle = bad ? "rgba(0,0,0,0.95)" : "rgba(0,0,0,0.55)";
            ctx.arc(ax, ay, bad ? 1.1 : 0.9, 0, Math.PI * 2);
            ctx.fill();

            ctx.beginPath();
            ctx.strokeStyle = bad ? "rgba(0,0,0,0.85)" : "rgba(0,0,0,0.32)";
            ctx.lineWidth = bad ? 0.7 : 0.45;
            ctx.moveTo(ax, ay);
            ctx.lineTo(ex, ey);
            ctx.stroke();

            // Box
            ctx.fillStyle = "rgba(255,255,255,0.96)";
            ctx.fillRect(lx - boxW / 2, ly - boxH / 2, boxW, boxH);
            ctx.strokeStyle = bad ? `rgba(${ALERT_RGB},0.6)` : "rgba(0,0,0,0.25)";
            ctx.lineWidth = 0.5;
            ctx.strokeRect(lx - boxW / 2, ly - boxH / 2, boxW, boxH);

            // Text
            ctx.fillStyle = isHighlighted
              ? bad
                ? `rgb(${ALERT_RGB})`
                : "#000"
              : bad
                ? `rgb(${ALERT_RGB})`
                : "rgba(0,0,0,0.85)";
            ctx.fillText(lbl, lx, ly + 0.5);
          }
        }}
        onLinkClick={(l: any) => {
          const key = linkKeyOf(l);
          setSelectedLink((prev) => (prev === key ? null : key));
          onInspectLink?.(l as AmlLink);
        }}
        nodeCanvasObject={(node: any, ctx) => {
          const isDao = node.label === "DAO_VAULT" || node.isSource;
          const score = node.score ?? 0;
          const crit = node.criticality ?? Math.round(score * 100);
          const bad = node.blacklisted;
          const frozen = !!frozenAddresses?.has(node.id);
          const dim = highlight && !highlight.nodeIds.has(node.id);

          const r = isDao ? 8 : bad || frozen ? 4.5 : node.label ? 4 : score > 0.7 ? 3 : 2;

          // Halo
          if (isDao && !dim) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 5, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(0,0,0,0.10)";
            ctx.fill();
          } else if (frozen && !dim) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${SUCCESS_RGB},0.22)`;
            ctx.fill();
          } else if (bad && !dim) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 3, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${ALERT_RGB},0.18)`;
            ctx.fill();
          }

          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
          if (dim) ctx.fillStyle = "rgba(0,0,0,0.12)";
          else if (isDao) ctx.fillStyle = "#000000";
          else if (frozen) ctx.fillStyle = `rgb(${SUCCESS_RGB})`;
          else if (bad) ctx.fillStyle = `rgb(${ALERT_RGB})`;
          else if (crit > 70) ctx.fillStyle = "#000000";
          else ctx.fillStyle = "#B5B5B5";
          ctx.fill();

          // Frozen ring (snowflake-style outer ring)
          if (frozen && !dim) {
            ctx.lineWidth = 1.4;
            ctx.strokeStyle = `rgb(${SUCCESS_RGB})`;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 2.5, 0, Math.PI * 2);
            ctx.stroke();
          } else if (crit > 70 && !dim && !isDao) {
            ctx.lineWidth = 1.2;
            ctx.strokeStyle = bad ? `rgb(${ALERT_RGB})` : "#000";
            ctx.stroke();
          }

          // Hub label (DAO_VAULT, TORNADO_CASH, BINANCE_HOT, …)
          if (node.label && !dim) {
            const isLegit = !bad;
            ctx.font = `700 ${isDao ? 12 : 10}px JetBrains Mono, monospace`;
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            const w = ctx.measureText(node.label).width;
            const padX = 4;
            const padY = 3;
            const boxY = node.y - r - 8 - (isDao ? 14 : 12);
            ctx.fillStyle = "rgba(255,255,255,0.97)";
            ctx.fillRect(node.x - w / 2 - padX, boxY, w + padX * 2, (isDao ? 14 : 12) + padY);
            const labelStroke = frozen
              ? `rgba(${SUCCESS_RGB},0.7)`
              : isLegit
                ? "rgba(0,0,0,0.4)"
                : `rgba(${ALERT_RGB},0.6)`;
            ctx.strokeStyle = labelStroke;
            ctx.lineWidth = 0.5;
            ctx.strokeRect(node.x - w / 2 - padX, boxY, w + padX * 2, (isDao ? 14 : 12) + padY);
            ctx.fillStyle = frozen ? `rgb(${SUCCESS_RGB})` : isLegit ? "#000" : `rgb(${ALERT_RGB})`;
            ctx.fillText(node.label, node.x, node.y - r - 8);
          }
        }}
        nodePointerAreaPaint={(node: any, color, ctx) => {
          ctx.fillStyle = color;
          const isDao = node.label === "DAO_VAULT" || node.isSource;
          const score = node.score ?? 0;
          const crit = node.criticality ?? Math.round(score * 100);
          // Generous hit area — red (blacklisted) dots get the largest target so they're trivial to click.
          const r = isDao ? 18 : node.blacklisted ? 18 : node.label ? 14 : crit > 70 ? 12 : 10;
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
          ctx.fill();

          // Make the visible address/label pill clickable too, not just the tiny node dot.
          if (node.label) {
            ctx.font = `700 ${isDao ? 12 : 10}px JetBrains Mono, monospace`;
            const w = ctx.measureText(node.label).width;
            const padX = 8;
            const boxH = (isDao ? 14 : 12) + 6;
            const boxY = node.y - (isDao ? 8 : node.blacklisted ? 4.5 : node.label ? 4 : score > 0.7 ? 3 : 2) - 8 - (isDao ? 14 : 12) - 3;
            ctx.fillRect(node.x - w / 2 - padX, boxY, w + padX * 2, boxH);
          }
        }}
        onNodeHover={(node: any) => {
          if (containerRef.current) {
            containerRef.current.style.cursor = node ? "pointer" : "default";
          }
          if (!node) {
            setHover(null);
            return;
          }
          if (fgRef.current && node.x != null && node.y != null) {
            const { x, y } = fgRef.current.graph2ScreenCoords(node.x, node.y);
            setHover({ x, y, node });
          }
          // Auto-open the investigation popup when hovering any red (blacklisted) node.
          if (node.blacklisted) {
            onInspectNode?.(node as AmlNode);
          }
        }}
        onLinkHover={(l: any) => {
          if (containerRef.current) {
            containerRef.current.style.cursor = l ? "pointer" : "default";
          }
        }}
        onNodeClick={(node: any) => {
          onInspectNode?.(node as AmlNode);
        }}
        onBackgroundClick={() => setSelectedLink(null)}
      />

      {hover && (() => {
        const isFrozen = !!frozenAddresses?.has(hover.node.id);
        return (
          <div
            className={`pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+10px)] border bg-background px-2.5 py-1.5 ${
              isFrozen ? "border-success" : hover.node.blacklisted ? "border-alert" : "hairline"
            }`}
            style={{ left: hover.x, top: hover.y }}
          >
            <div className="font-mono text-[10px] text-ink">
              {hover.node.address.slice(0, 14)}…{hover.node.address.slice(-4)}
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="label-micro">CRIT</span>
              <span
                className={`font-mono text-[11px] ${
                  (hover.node.criticality ?? 0) > 70 ? "font-semibold text-ink" : "text-ink-muted"
                }`}
              >
                {(hover.node.criticality ?? Math.round((hover.node.score ?? 0) * 100))}/100
              </span>
              <span className="label-micro">HOPS</span>
              <span className="font-mono text-[10px] text-ink-muted">{hover.node.hops}</span>
              {isFrozen ? (
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-success">
                  ❄ FROZEN
                </span>
              ) : hover.node.blacklisted ? (
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-alert">
                  LAUNDERING
                </span>
              ) : null}
            </div>
            {hover.node.label && (
              <div className={`mt-0.5 font-mono text-[10px] ${isFrozen ? "text-success" : "text-alert"}`}>
                {hover.node.label}
              </div>
            )}
          </div>
        );
      })()}

      {scanning && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-2 w-2 rounded-full bg-foreground animate-scan" />
        </div>
      )}

      {/* Auto-collision toggle */}
      <div className="absolute right-4 top-4 z-10">
        <button
          onClick={() => setAutoDeclutter((v) => !v)}
          className={`flex items-center gap-2 border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
            autoDeclutter
              ? "border-foreground bg-foreground text-background"
              : "border-foreground bg-background text-foreground hover:bg-foreground/5"
          }`}
          title="Réduit dynamiquement le nombre d'adresses affichées selon le zoom"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              autoDeclutter ? "bg-background" : "bg-foreground"
            }`}
          />
          LABEL_AUTO_COLLISION · {autoDeclutter ? "ON" : "OFF"}
        </button>
      </div>

      <div className="pointer-events-none absolute bottom-4 left-4 space-y-1">
        <div className="label-micro">NODES_RENDERED / {nodes.length.toLocaleString()}</div>
        <div className="label-micro">EDGES / {links.length.toLocaleString()}</div>
        <div className="flex items-center gap-2 pt-1">
          <span className="h-2 w-2 rounded-full bg-foreground" />
          <span className="label-micro">DAO / LEGIT_FLOW</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-alert" />
          <span className="label-micro">LAUNDERING_FLOW</span>
        </div>
        {(frozenAddresses?.size ?? 0) > 0 && (
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            <span className="label-micro">FROZEN / {frozenAddresses!.size}</span>
          </div>
        )}
        {selectedLink && (
          <div className="pointer-events-auto pt-1">
            <button
              onClick={() => setSelectedLink(null)}
              className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink underline underline-offset-2"
            >
              CLEAR_PATH
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
