import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fmtNum, fmtTime } from "../format";

// Canvas line chart for live trace, run overlays, indicator trends and SPC.
// Marks follow the dataviz specs: 2px lines, hairline solid grid, threshold
// lines dashed (they ARE thresholds), >= 8px markers with a surface ring, a
// crosshair that snaps to the nearest X and one tooltip listing every series.

export interface Series {
  id: string;
  label: string;
  color: string;
  points: Array<[number, number]>;
  width?: number;
  /** Faded context series (e.g. previous runs). */
  faint?: boolean;
  /** Draw a marker on every point (SPC individuals). */
  dots?: boolean;
  /** Step line (setpoints). */
  step?: boolean;
  dash?: number[];
  /** Leave out of the legend and tooltip. */
  quiet?: boolean;
  /** Markers only (with dots). */
  noLine?: boolean;
}

export interface RefLine {
  y: number;
  label: string;
  color: string;
  dash?: boolean;
}

export interface Marker {
  x: number;
  y: number;
  color: string;
  label?: string;
}

export interface Band {
  x0: number;
  x1: number;
  label: string;
}

interface Props {
  series: Series[];
  refLines?: RefLine[];
  markers?: Marker[];
  bands?: Band[];
  height?: number;
  xType?: "time" | "number";
  xFormat?: (x: number) => string;
  yFormat?: (y: number) => string;
  xDomain?: [number, number];
  yDomain?: [number, number];
  /** Break a line where consecutive points are further apart than this (x units). */
  maxGap?: number;
  legend?: boolean;
  /** Extra tooltip line for an X (e.g. lot / wafer of an SPC point). */
  describe?: (x: number) => string | null;
  onPick?: (x: number) => void;
  ariaLabel: string;
}

const PAD_BASE = { l: 56, t: 10, b: 24 };

function cssColor(c: string, el: Element): string {
  const m = c.match(/^var\((--[\w-]+)\)$/);
  if (!m) return c;
  return getComputedStyle(el).getPropertyValue(m[1]).trim() || "#888";
}

function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo];
  const span = hi - lo;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400].map((s) => s * 1000);

function timeTicks(lo: number, hi: number, count: number): number[] {
  const step = TIME_STEPS.find((s) => (hi - lo) / s <= count) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const offset = new Date(lo).getTimezoneOffset() * 60_000;
  const out: number[] = [];
  for (let v = Math.ceil((lo - offset) / step) * step + offset; v <= hi; v += step) out.push(v);
  return out;
}

function nearestIdx(points: Array<[number, number]>, x: number): number {
  let lo = 0;
  let hi = points.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo][0] - x) <= Math.abs(points[hi][0] - x) ? lo : hi;
}

function useThemeVersion() {
  const [v, setV] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const bump = () => setV((x) => x + 1);
    mq.addEventListener("change", bump);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", bump);
      mo.disconnect();
    };
  }, []);
  return v;
}

interface Hover {
  px: number;
  x: number;
}

export function LineChart(props: Props) {
  const { series, refLines = [], markers = [], bands = [], height = 220, xType = "time", legend = true } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<Hover | null>(null);
  const theme = useThemeVersion();
  // Right margin only when threshold labels need it.
  const PAD = { ...PAD_BASE, r: refLines.length ? 64 : 16 };
  const xf = props.xFormat ?? (xType === "time" ? (x: number) => fmtTime(x) : (x: number) => fmtNum(x, 3));
  const yf = props.yFormat ?? ((y: number) => fmtNum(y, 4));

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(200, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  // Domains
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const s of series) {
    for (const [x, y] of s.points) {
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (Number.isFinite(y)) {
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
  }
  for (const r of refLines) {
    if (!Number.isFinite(r.y)) continue;
    yMin = Math.min(yMin, r.y);
    yMax = Math.max(yMax, r.y);
  }
  if (props.xDomain) [xMin, xMax] = props.xDomain;
  if (props.yDomain) [yMin, yMax] = props.yDomain;
  const hasData = Number.isFinite(xMin) && Number.isFinite(yMin);
  if (hasData) {
    if (xMax === xMin) {
      xMin -= 1;
      xMax += 1;
    }
    if (yMax === yMin) {
      const d = Math.abs(yMin) * 0.05 || 1;
      yMin -= d;
      yMax += d;
    } else if (!props.yDomain) {
      const pad = (yMax - yMin) * 0.08;
      yMin -= pad;
      yMax += pad;
    }
  }
  const plotW = width - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;
  const sx = (x: number) => PAD.l + ((x - xMin) / (xMax - xMin)) * plotW;
  const sy = (y: number) => PAD.t + (1 - (y - yMin) / (yMax - yMin)) * plotH;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const root = document.documentElement;
    const col = (c: string) => cssColor(c, root);
    const grid = col("var(--grid)");
    const axis = col("var(--axis)");
    const muted = col("var(--text-muted)");
    const surface = col("var(--surface-1)");
    ctx.font = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";
    if (!hasData) return;

    // step bands (alternate wash) + labels
    bands.forEach((b, i) => {
      const x0 = Math.max(PAD.l, sx(b.x0));
      const x1 = Math.min(PAD.l + plotW, sx(b.x1));
      if (x1 <= x0) return;
      if (i % 2 === 1) {
        ctx.fillStyle = col("var(--surface-2)");
        ctx.fillRect(x0, PAD.t, x1 - x0, plotH);
      }
      ctx.fillStyle = muted;
      ctx.textAlign = "left";
      const label = b.label;
      if (ctx.measureText(label).width < x1 - x0 - 6) ctx.fillText(label, x0 + 4, PAD.t + 11);
    });

    // grid + y ticks
    ctx.lineWidth = 1;
    ctx.strokeStyle = grid;
    ctx.fillStyle = muted;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const t of niceTicks(yMin, yMax, Math.max(3, Math.floor(plotH / 45)))) {
      const y = Math.round(sy(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(PAD.l + plotW, y);
      ctx.stroke();
      ctx.fillText(yf(t), PAD.l - 6, y);
    }
    // x ticks
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const xCount = Math.max(2, Math.floor(plotW / 90));
    const xticks = xType === "time" ? timeTicks(xMin, xMax, xCount) : niceTicks(xMin, xMax, xCount);
    for (const t of xticks) {
      const x = sx(t);
      if (x < PAD.l || x > PAD.l + plotW) continue;
      ctx.fillText(xf(t), x, PAD.t + plotH + 6);
    }
    ctx.strokeStyle = axis;
    ctx.beginPath();
    ctx.moveTo(PAD.l, Math.round(PAD.t + plotH) + 0.5);
    ctx.lineTo(PAD.l + plotW, Math.round(PAD.t + plotH) + 0.5);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.l, PAD.t - 2, plotW, plotH + 4);
    ctx.clip();

    // reference (threshold) lines
    for (const r of refLines) {
      if (!Number.isFinite(r.y)) continue;
      const y = Math.round(sy(r.y)) + 0.5;
      ctx.strokeStyle = col(r.color);
      ctx.lineWidth = 1;
      ctx.setLineDash(r.dash === false ? [] : [5, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(PAD.l + plotW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // series: faint first
    const ordered = [...series].sort((a, b) => Number(!!b.faint) - Number(!!a.faint));
    for (const s of ordered) {
      if (!s.points.length) continue;
      ctx.strokeStyle = col(s.color);
      ctx.globalAlpha = s.faint ? 0.28 : 1;
      ctx.lineWidth = s.width ?? 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.setLineDash(s.dash ?? []);
      ctx.beginPath();
      let started = false;
      let prevY = 0;
      let prevX = -Infinity;
      for (const [x, y] of s.points) {
        if (!Number.isFinite(y) || (props.maxGap !== undefined && x - prevX > props.maxGap)) started = false;
        prevX = x;
        if (!Number.isFinite(y)) continue;
        const px = sx(x);
        const py = sy(y);
        if (s.noLine) continue;
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else if (s.step) {
          ctx.lineTo(px, prevY);
          ctx.lineTo(px, py);
        } else ctx.lineTo(px, py);
        prevY = py;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (s.dots) {
        for (const [x, y] of s.points) {
          if (!Number.isFinite(y)) continue;
          ctx.beginPath();
          ctx.arc(sx(x), sy(y), 4, 0, Math.PI * 2);
          ctx.fillStyle = col(s.color);
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = surface;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // highlighted markers (violations)
    for (const m of markers) {
      ctx.beginPath();
      ctx.arc(sx(m.x), sy(m.y), 5, 0, Math.PI * 2);
      ctx.fillStyle = col(m.color);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = surface;
      ctx.stroke();
    }
    ctx.restore();

    // reference labels on the right edge (text in ink, key in color)
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    let lastY = -100;
    const placed = refLines
      .filter((r) => Number.isFinite(r.y))
      .map((r) => ({ r, y: sy(r.y) }))
      .filter(({ y }) => y >= PAD.t - 2 && y <= PAD.t + plotH + 2)
      .sort((a, b) => a.y - b.y);
    for (const { r, y } of placed) {
      if (y - lastY < 12) continue;
      lastY = y;
      ctx.fillStyle = col(r.color);
      ctx.fillRect(PAD.l + plotW + 4, y - 1, 8, 2);
      ctx.fillStyle = muted;
      ctx.fillText(r.label, PAD.l + plotW + 15, y);
    }

    // crosshair
    if (hover) {
      ctx.strokeStyle = col("var(--text-muted)");
      ctx.lineWidth = 1;
      const x = Math.round(sx(hover.x)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, PAD.t + plotH);
      ctx.stroke();
      for (const s of series) {
        if (s.quiet || s.faint) continue;
        const i = nearestIdx(s.points, hover.x);
        if (i < 0) continue;
        const [px, py] = s.points[i];
        if (Math.abs(sx(px) - sx(hover.x)) > 24 || !Number.isFinite(py)) continue;
        ctx.beginPath();
        ctx.arc(sx(px), sy(py), 4, 0, Math.PI * 2);
        ctx.fillStyle = col(s.color);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = surface;
        ctx.stroke();
      }
    }
  });

  const onMove = (e: React.PointerEvent) => {
    if (!hasData) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < PAD.l || px > PAD.l + plotW) {
      setHover(null);
      return;
    }
    const x = xMin + ((px - PAD.l) / plotW) * (xMax - xMin);
    // snap to the nearest data X of the first visible series
    let best = x;
    let bestD = Infinity;
    for (const s of series) {
      if (s.quiet || s.faint) continue;
      const i = nearestIdx(s.points, x);
      if (i >= 0 && Math.abs(s.points[i][0] - x) < bestD) {
        bestD = Math.abs(s.points[i][0] - x);
        best = s.points[i][0];
      }
    }
    setHover({ px: sx(best), x: best });
  };

  const rows = hover
    ? series
        .filter((s) => !s.quiet && !s.faint)
        .map((s) => {
          const i = nearestIdx(s.points, hover.x);
          if (i < 0) return null;
          const [px, py] = s.points[i];
          if (Math.abs(sx(px) - hover.px) > 24) return null;
          return { s, y: py };
        })
        .filter(Boolean)
    : [];
  const desc = hover && props.describe ? props.describe(hover.x) : null;
  const legendItems = series.filter((s) => !s.quiet && !s.faint);

  return (
    <div className="chart" ref={wrapRef}>
      {legend && legendItems.length > 1 && (
        <div className="legend">
          {legendItems.map((s) => (
            <span key={s.id}>
              <i className="key-line" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={props.ariaLabel}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onClick={() => hover && props.onPick?.(hover.x)}
        style={{ cursor: props.onPick ? "pointer" : "crosshair" }}
        data-theme-v={theme}
      />
      {!hasData && <div className="empty" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>—</div>}
      {hover && (rows.length > 0 || desc) && (
        <div
          className="tooltip"
          style={{
            left: Math.min(hover.px + 12, width - 200),
            top: PAD.t + 4,
          }}
        >
          <div className="tt-head">{xf(hover.x)}</div>
          {desc && <div className="tt-head">{desc}</div>}
          {rows.map((r) => (
            <div className="tt-row" key={r!.s.id}>
              <i className="key-line" style={{ background: r!.s.color }} />
              <b>{yf(r!.y)}</b>
              <span>{r!.s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
