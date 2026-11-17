"use client";

import { useEffect, useState } from "react";
import { formatPrice, getPacks, startCheckout, type Packs } from "@/lib/face-to-face/api";

/** Price cards. With `canBuy`, each card starts Stripe Checkout; otherwise they only show prices. */
export function Pricing({ canBuy, compact = false }: { canBuy: boolean; compact?: boolean }) {
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

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        {packs.packs.map((pack) => (
          <div
            key={pack.id}
            style={{
              background: "var(--ip-surface-2)",
              border: "1px solid var(--ip-border)",
              borderRadius: 12,
              padding: compact ? 14 : 18,
            }}
          >
            <p style={{ margin: 0, fontWeight: 600 }}>{pack.label || `${pack.credits} interviews`}</p>
            <p style={{ margin: "6px 0", fontSize: compact ? 20 : 26, fontWeight: 700 }}>
              {formatPrice(pack.price_cents, packs.currency)}
            </p>
            <p className="ip-muted" style={{ margin: "0 0 12px" }}>
              {formatPrice(Math.round(pack.price_cents / pack.credits), packs.currency)} per interview
            </p>
            {canBuy && (
              <button type="button" className="ip-primary" disabled={busy !== null} onClick={() => void buy(pack.id)} style={{ width: "100%" }}>
                {busy === pack.id ? "Opening checkout" : "Buy"}
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="ip-muted" style={{ marginBottom: 0 }}>
        Each interview includes planning from your resume, scoring for every answer and up to 15 stronger
        answers. Payments are handled by Stripe; card details never reach InterviewPilot. Credits don&apos;t expire.
      </p>
      {problem && (
        <p className="ip-banner is-alert" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
