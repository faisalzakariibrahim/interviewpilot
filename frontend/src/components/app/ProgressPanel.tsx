"use client";

// Progress across interviews: the average score of each session over time,
// and the average by question type. Plain SVG, no chart library. Hover or
// focus a point or bar for its exact value; a table holds the same numbers.

import { useMemo, useState } from "react";
import type { FaceToFaceResult } from "@/lib/face-to-face/store";

const SERIES = "#5b8cff"; // validated against the #0b1530 surface (contrast and lightness band)
const LABELS: Record<string, string> = {
  behavioral: "Behavioral",
  technical: "Technical",
  situational: "Situational",
  motivation: "Motivation",
  experience: "Experience",
};

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface Point {
  id: string;
  when: string;
  role: string;
  average: number;
  answers: number;
}

function TrendChart({ points }: { points: Point[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 640;
  const height = 220;
  const pad = { top: 16, right: 16, bottom: 30, left: 34 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (value: number) => pad.top + innerH - (value / 10) * innerH;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.average).toFixed(1)}`).join(" ");
  const active = hover !== null ? points[hover] : null;

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="Average score per interview, over time">
        {[0, 5, 10].map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke="var(--ip-border)" strokeWidth={1} />
            <text x={pad.left - 8} y={y(tick) + 4} textAnchor="end" fontSize={11} fill="var(--ip-muted)">
              {tick}
            </text>
          </g>
        ))}
        {points.length > 1 && <path d={path} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" />}
        {points.map((p, i) => (
          <g key={p.id}>
            <circle cx={x(i)} cy={y(p.average)} r={hover === i ? 6 : 4.5} fill={SERIES} stroke="var(--ip-surface)" strokeWidth={2} />
            {/* A bigger, invisible hit target than the dot itself. */}
            <circle
              cx={x(i)}
              cy={y(p.average)}
              r={16}
              fill="transparent"
              tabIndex={0}
              aria-label={`${shortDate(p.when)}: ${p.average} out of 10`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            />
          </g>
        ))}
        {points.length > 0 && (
          <>
            <text x={x(0)} y={height - 8} textAnchor={points.length === 1 ? "middle" : "start"} fontSize={11} fill="var(--ip-muted)">
              {shortDate(points[0]!.when)}
            </text>
            {points.length > 1 && (
              <text x={x(points.length - 1)} y={height - 8} textAnchor="end" fontSize={11} fill="var(--ip-muted)">
                {shortDate(points[points.length - 1]!.when)}
              </text>
            )}
          </>
        )}
      </svg>
      {active && hover !== null && (
        <div
          role="status"
          style={{
            position: "absolute",
            left: `${(x(hover) / width) * 100}%`,
            top: `${(y(active.average) / height) * 100}%`,
            transform: "translate(-50%, calc(-100% - 12px))",
            background: "var(--ip-surface-2)",
            border: "1px solid var(--ip-border)",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 13,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          <strong>{active.average} / 10</strong>
          <span className="ip-muted">
            {" "}
            · {shortDate(active.when)} · {active.role} · {active.answers} answer{active.answers === 1 ? "" : "s"}
          </span>
        </div>
      )}
    </div>
  );
}

function CategoryBars({ rows }: { rows: Array<{ key: string; average: number; count: number }> }) {
  return (
    <div style={{ display: "grid", gap: 10 }} role="list" aria-label="Average score by question type">
      {rows.map((row) => (
        <div key={row.key} role="listitem" style={{ display: "grid", gridTemplateColumns: "110px 1fr 70px", gap: 10, alignItems: "center" }}>
          <span style={{ fontSize: 14 }}>{LABELS[row.key] ?? row.key}</span>
          <div style={{ background: "var(--ip-surface-2)", borderRadius: 4, height: 12 }} title={`${row.average} / 10 over ${row.count} answers`}>
            <div style={{ width: `${(row.average / 10) * 100}%`, height: "100%", background: SERIES, borderRadius: 4 }} />
          </div>
          <span style={{ fontSize: 14, textAlign: "right" }}>
            {row.average}
            <span className="ip-muted"> ({row.count})</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function ProgressPanel({ results }: { results: FaceToFaceResult[] }) {
  const [showTable, setShowTable] = useState(false);

  const points = useMemo<Point[]>(
    () =>
      results
        .filter((r) => r.average !== null)
        .map((r) => ({
          id: `${r.id}-${r.startedAt}`,
          when: r.startedAt,
          role: r.role,
          average: r.average as number,
          answers: r.turns.filter((t) => t.score).length,
        }))
        .sort((a, b) => a.when.localeCompare(b.when)),
    [results],
  );

  const categories = useMemo(() => {
    const totals = new Map<string, { sum: number; count: number }>();
    for (const result of results) {
      for (const turn of result.turns) {
        if (!turn.score || !turn.category) continue;
        const entry = totals.get(turn.category) ?? { sum: 0, count: 0 };
        entry.sum += turn.score.score;
        entry.count += 1;
        totals.set(turn.category, entry);
      }
    }
    return [...totals.entries()]
      .map(([key, { sum, count }]) => ({ key, count, average: Math.round((sum / count) * 10) / 10 }))
      .sort((a, b) => a.average - b.average);
  }, [results]);

  if (!points.length) return null;
  const first = points[0]!.average;
  const last = points[points.length - 1]!.average;
  const change = Math.round((last - first) * 10) / 10;

  return (
    <section className="ip-card" aria-labelledby="progress-title">
      <div className="ip-row" style={{ justifyContent: "space-between" }}>
        <h2 id="progress-title">Your progress</h2>
        <button type="button" className="ip-ghost" onClick={() => setShowTable((v) => !v)}>
          {showTable ? "Show chart" : "Show as table"}
        </button>
      </div>
      <p className="ip-muted" style={{ marginTop: 0 }}>
        Average score per interview.{" "}
        {points.length > 1 && (
          <>
            Latest {last} / 10, {change >= 0 ? `up ${change}` : `down ${Math.abs(change)}`} since your first.
          </>
        )}
      </p>

      {showTable ? (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr className="ip-muted" style={{ textAlign: "left" }}>
              <th style={{ padding: "6px 0" }}>Date</th>
              <th>Role</th>
              <th style={{ textAlign: "right" }}>Answers</th>
              <th style={{ textAlign: "right" }}>Average</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.id} style={{ borderTop: "1px solid var(--ip-border)" }}>
                <td style={{ padding: "6px 0" }}>{shortDate(p.when)}</td>
                <td>{p.role}</td>
                <td style={{ textAlign: "right" }}>{p.answers}</td>
                <td style={{ textAlign: "right" }}>{p.average}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <TrendChart points={points} />
      )}

      {categories.length > 0 && (
        <>
          <h3 style={{ margin: "20px 0 10px", fontSize: 16 }}>By question type</h3>
          <p className="ip-muted" style={{ marginTop: 0 }}>
            Average score, weakest first. In brackets: how many answers it&apos;s based on.
          </p>
          <CategoryBars rows={categories} />
        </>
      )}
    </section>
  );
}
