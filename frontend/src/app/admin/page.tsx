"use client";

// Owner dashboard. Only accounts listed in the database's ip_admins table get data;
// everyone else sees a refusal. Shows accounts, activity, plans and money, never the
// content of resumes, notes or interviews (those stay encrypted and private).

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { formatPrice, getAdminOverview, type AdminOverview, type AdminUser } from "@/lib/face-to-face/api";

const ACCENT = "#5b8cff";

function when(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < -1) return "on " + date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ background: "var(--ip-surface-2)", border: "1px solid var(--ip-border)", borderRadius: 12, padding: 14 }}>
      <p className="ip-muted" style={{ margin: 0, fontSize: 13 }}>{label}</p>
      <p style={{ margin: "4px 0 0", fontSize: 26, fontWeight: 700 }}>{value}</p>
      {note && <p className="ip-muted" style={{ margin: "2px 0 0", fontSize: 12 }}>{note}</p>}
    </div>
  );
}

/** Last 30 days as thin bars; hover a bar for the day and count. */
function Bars({ title, series }: { title: string; series: { day: string; count: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((point) => point.count));
  const total = series.reduce((sum, point) => sum + point.count, 0);
  const width = 600;
  const height = 120;
  const step = width / series.length;
  const shown = hover === null ? null : series[hover];
  return (
    <div>
      <div className="ip-row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
        <span className="ip-muted" style={{ fontSize: 13 }}>
          {shown
            ? `${new Date(shown.day + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${shown.count}`
            : `${total} in 30 days`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height + 18}`}
        role="img"
        aria-label={`${title}: ${total} in the last 30 days, at most ${max} in one day`}
        style={{ width: "100%", height: "auto", display: "block", marginTop: 8 }}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={0} x2={width} y1={height} y2={height} stroke="var(--ip-border)" strokeWidth={1} />
        {series.map((point, i) => {
          const h = point.count ? Math.max(3, (point.count / max) * (height - 6)) : 0;
          return (
            <g key={point.day} onMouseEnter={() => setHover(i)}>
              <rect x={i * step} y={0} width={step} height={height} fill="transparent" />
              {h > 0 && (
                <rect
                  x={i * step + 2}
                  y={height - h}
                  width={Math.max(2, step - 4)}
                  height={h}
                  rx={Math.min(4, (step - 4) / 2)}
                  fill={ACCENT}
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
            </g>
          );
        })}
        <text x={0} y={height + 14} fontSize={11} fill="var(--ip-muted)">30 days ago</text>
        <text x={width} y={height + 14} fontSize={11} fill="var(--ip-muted)" textAnchor="end">today</text>
      </svg>
    </div>
  );
}

function planLabel(user: AdminUser): string {
  if (user.admin) return "Owner";
  if (user.subscribed) return user.plan_cancelling ? "Monthly (cancelling)" : "Monthly";
  if (user.plan_status) return `Plan ${user.plan_status.replace(/_/g, " ")}`;
  return user.free_left > 0 ? "Free interview left" : "Free used";
}

export default function AdminPage() {
  const auth = useAuth();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getAdminOverview());
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't load the dashboard.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (auth.status !== "signed-in") return;
    void load();
    const timer = setInterval(() => void load(), 60000);
    return () => clearInterval(timer);
  }, [auth.status, load]);

  const users = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return (data?.users ?? []).filter((user) => !term || user.email.toLowerCase().includes(term));
  }, [data, filter]);

  if (auth.status === "loading") return <main className="ip-shell"><p className="ip-muted">Loading…</p></main>;
  if (auth.status !== "signed-in") {
    return (
      <main className="ip-shell">
        <p>Sign in on the <Link href="/">main page</Link> first.</p>
      </main>
    );
  }

  const t = data?.totals ?? {};
  const money = (cents: number) => formatPrice(cents, data?.currency ?? "usd");

  return (
    <main className="ip-shell" style={{ maxWidth: 1100 }}>
      <header className="ip-header">
        <h1>InterviewPilot admin</h1>
        <span className="ip-row" style={{ gap: 8 }}>
          <button type="button" className="ip-ghost" onClick={() => void load()} disabled={loading}>
            {loading ? "Refreshing" : "Refresh"}
          </button>
          <Link href="/" className="ip-ghost" style={{ padding: "8px 12px", borderRadius: 8, textDecoration: "none" }}>
            Back to app
          </Link>
        </span>
      </header>

      {problem && <p className="ip-banner is-alert" role="alert">{problem}</p>}
      {!data && !problem && <p className="ip-muted">Loading the numbers…</p>}

      {data && (
        <>
          <p className="ip-muted" style={{ marginTop: 0 }}>
            Updated {when(data.generated_at)}; refreshes every minute. Resumes, notes and answers stay private to each
            user and aren&apos;t shown here.
          </p>

          <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 20 }}>
            <Tile label="Users" value={String(t.users ?? 0)} note={`${t.signups_7d ?? 0} new this week`} />
            <Tile label="Active this week" value={String(t.active_7d ?? 0)} note="started an interview" />
            <Tile
              label="Subscribers"
              value={String(t.subscribers ?? 0)}
              note={t.cancelling ? `${t.cancelling} cancelling` : "monthly plan"}
            />
            <Tile label="Monthly revenue" value={money(t.monthly_revenue_cents ?? 0)} note="from active plans" />
            <Tile label="Interviews" value={String(t.interviews_total ?? 0)} note={`${t.interviews_7d ?? 0} this week`} />
            <Tile label="Free interviews unused" value={String(t.free_interviews_left ?? 0)} />
            <Tile label="Resumes uploaded" value={String(t.resumes_uploaded ?? 0)} note={`${t.scorecards_saved ?? 0} scorecards saved`} />
            <Tile label="Job links read" value={String(t.job_links_read_7d ?? 0)} note="this week" />
          </section>

          <section className="ip-card" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 24 }}>
            <Bars title="Sign-ups per day" series={data.signups_by_day ?? []} />
            <Bars title="Interviews started per day" series={data.interviews_by_day ?? []} />
          </section>

          <section className="ip-card">
            <div className="ip-row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <h2 style={{ margin: 0 }}>Users ({data.users.length})</h2>
              <input
                type="search"
                placeholder="Search by email"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                style={{
                  maxWidth: 260,
                  background: "var(--ip-surface-2)",
                  color: "var(--ip-text)",
                  border: "1px solid var(--ip-border)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  font: "inherit",
                }}
              />
            </div>
            <div style={{ overflowX: "auto", marginTop: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead>
                  <tr className="ip-muted" style={{ textAlign: "left" }}>
                    {["Email", "Plan", "Interviews", "Last interview", "Resumes", "Signed up", "Last sign-in"].map((h) => (
                      <th key={h} style={{ padding: "8px 10px", borderBottom: "1px solid var(--ip-border)", fontWeight: 500, whiteSpace: "nowrap" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.email + user.signed_up}>
                      <td style={cell}>
                        {user.email}
                        {!user.confirmed && <span className="ip-muted"> (unconfirmed)</span>}
                      </td>
                      <td style={cell}>
                        {planLabel(user)}
                        {user.subscribed && user.plan_renews && (
                          <span className="ip-muted"> · {user.plan_cancelling ? "ends" : "renews"} {when(user.plan_renews)}</span>
                        )}
                      </td>
                      <td style={{ ...cell, textAlign: "right" }}>{user.interviews}</td>
                      <td style={cell}>{when(user.last_interview)}</td>
                      <td style={{ ...cell, textAlign: "right" }}>{user.resumes}</td>
                      <td style={cell}>{when(user.signed_up)}</td>
                      <td style={cell}>{when(user.last_sign_in)}</td>
                    </tr>
                  ))}
                  {!users.length && (
                    <tr>
                      <td style={cell} colSpan={7} className="ip-muted">No users match.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="ip-card">
            <h2>Recent activity</h2>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {data.recent.map((event, i) => (
                <li key={i} className="ip-row" style={{ justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--ip-border)", gap: 12 }}>
                  <span>
                    <strong style={{ fontWeight: 600 }}>
                      {event.kind === "signup" ? "Signed up" : event.kind === "interview" ? "Started an interview" : "Plan changed"}
                    </strong>{" "}
                    {event.email}
                    {event.detail && <span className="ip-muted"> · {event.detail}</span>}
                  </span>
                  <span className="ip-muted" style={{ whiteSpace: "nowrap" }}>{when(event.at)}</span>
                </li>
              ))}
              {!data.recent.length && <li className="ip-muted">Nothing yet.</li>}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}

const cell: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--ip-border)", whiteSpace: "nowrap" };
