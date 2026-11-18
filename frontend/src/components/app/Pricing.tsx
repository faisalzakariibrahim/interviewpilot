"use client";

import { useEffect, useState } from "react";
import { formatPrice, getPacks, startCheckout, type Pack, type Packs } from "@/lib/face-to-face/api";

/** Price cards. With `canBuy`, each card starts Stripe Checkout; otherwise they only show prices. */
export function Pricing({
  canBuy,
  compact = false,
  hideMonthly = false,
}: {
  canBuy: boolean;
  compact?: boolean;
  /** Hide the monthly card (already subscribed). */
  hideMonthly?: boolean;
}) {
  const [packs, setPacks] = useState<Packs | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void getPacks().then(setPacks);
  }, []);

  async function buy(id: string) {
    setBusy(id);
    setProblem(null);
    try {
      window.location.assign(await startCheckout(id));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't open checkout.");
      setBusy(null);
    }
  }

  if (!packs?.enabled || !packs.packs.length) return null;
  const shown = packs.packs.filter((pack) => !(hideMonthly && pack.kind === "monthly"));

  function describe(pack: Pack) {
    const price = formatPrice(pack.price_cents, packs!.currency);
    return pack.kind === "monthly"
      ? { title: pack.label || "Monthly", price, unit: "per month", note: `Up to ${packs!.monthly_limit ?? 60} interviews a month. Cancel any time.`, action: "Subscribe for " + price + "/month" }
      : {
          title: pack.label || "Pay as you go",
          price,
          unit: "per interview",
          note: `Buy 1 to ${pack.max_quantity} at a time; choose how many at checkout. Never expire.`,
          action: "Buy interviews",
        };
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {!canBuy && (
          <div style={{ background: "var(--ip-surface-2)", border: "1px solid var(--ip-border)", borderRadius: 12, padding: compact ? 14 : 18 }}>
            <p style={{ margin: 0, fontWeight: 600 }}>First interview</p>
            <p style={{ margin: "6px 0 0" }}>
              <span style={{ fontSize: compact ? 22 : 28, fontWeight: 700 }}>Free</span>
            </p>
            <p className="ip-muted" style={{ margin: "6px 0 12px" }}>Every new account gets one full interview with scorecard. No card needed.</p>
          </div>
        )}
        {shown.map((pack) => {
          const card = describe(pack);
          return (
            <div
              key={pack.id}
              style={{
                background: "var(--ip-surface-2)",
                border: "1px solid var(--ip-border)",
                borderRadius: 12,
                padding: compact ? 14 : 18,
              }}
            >
              <p style={{ margin: 0, fontWeight: 600 }}>{card.title}</p>
              <p style={{ margin: "6px 0 0" }}>
                <span style={{ fontSize: compact ? 22 : 28, fontWeight: 700 }}>{card.price}</span>{" "}
                <span className="ip-muted">{card.unit}</span>
              </p>
              <p className="ip-muted" style={{ margin: "6px 0 12px" }}>{card.note}</p>
              {canBuy && (
                <button
                  type="button"
                  className="ip-primary"
                  disabled={busy !== null}
                  onClick={() => void buy(pack.id)}
                  style={{ width: "100%" }}
                >
                  {busy === pack.id ? "Opening checkout" : card.action}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="ip-muted" style={{ marginBottom: 0 }}>
        Each interview includes planning from your resume, scoring for every answer and up to 15 stronger answers.
        Payments are handled by Stripe; card details never reach InterviewPilot.
      </p>
      {problem && (
        <p className="ip-banner is-alert" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
