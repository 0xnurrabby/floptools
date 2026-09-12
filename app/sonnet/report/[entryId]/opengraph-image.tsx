import { ImageResponse } from "next/og";

/**
 * Social preview card for a voters & rug report: entry, counted voters and
 * the coordination-risk reading, with the top signals. Rendered server-side
 * from the public report API so sharing the link gives a real card.
 */

export const alt = "Sonnet-2 voters & rug report";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://floptools.nurlab.xyz";

interface CardData {
  gameId?: string | null;
  votes?: number;
  risk?: { score: number; level: string; summary: string };
  signals?: { severity: string; label: string }[];
}

export default async function Image({ params }: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await params;
  let data: CardData = {};
  try {
    const res = await fetch(
      `${BASE}/api/sonnet/entry-votes?entryId=${encodeURIComponent(entryId.toLowerCase())}`,
      { cache: "no-store", signal: AbortSignal.timeout(30_000) },
    );
    if (res.ok) data = (await res.json()) as CardData;
  } catch {
    /* a bare card still renders */
  }

  const risk = data.risk;
  const color = risk?.level === "high" ? "#e11d48" : risk?.level === "notable" ? "#d97706" : "#16a34a";
  const signals = (data.signals ?? []).slice(0, 3);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 64,
          background: "linear-gradient(135deg, #ffffff 0%, #eef2ff 55%, #fdf2f8 100%)",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              display: "flex",
              width: 58,
              height: 58,
              borderRadius: 16,
              background: "#0b0b0f",
              color: "#ffffff",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
              fontWeight: 700,
            }}
          >
            f
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 26, fontWeight: 700, color: "#0b0b0f" }}>floptools · sonnet-2</div>
            <div style={{ display: "flex", fontSize: 20, color: "#52525b" }}>voters &amp; rug report</div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", fontSize: 66, fontWeight: 800, color: "#0b0b0f", letterSpacing: -1 }}>
            {data.gameId ?? entryId}
          </div>
          <div style={{ display: "flex", gap: 24 }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                background: "#ffffff",
                border: "1px solid #e4e4e7",
                borderRadius: 20,
                padding: "18px 30px",
              }}
            >
              <div style={{ display: "flex", fontSize: 20, color: "#71717a" }}>counted voters</div>
              <div style={{ display: "flex", fontSize: 46, fontWeight: 800, color: "#0b0b0f" }}>{data.votes ?? 0}</div>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                background: "#ffffff",
                border: "1px solid #e4e4e7",
                borderRadius: 20,
                padding: "18px 30px",
              }}
            >
              <div style={{ display: "flex", fontSize: 20, color: "#71717a" }}>coordination risk</div>
              <div style={{ display: "flex", fontSize: 46, fontWeight: 800, color }}>
                {`${risk?.score ?? 0}/100 · ${risk?.level ?? "low"}`}
              </div>
            </div>
          </div>
          {signals.map((s, i) => (
            <div key={i} style={{ display: "flex", fontSize: 24, color: "#3f3f46" }}>
              {`• ${s.label}`}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, color: "#71717a" }}>
          <span>floptools.nurlab.xyz/sonnet/top-sonnet</span>
          <span>public ledger data · not proof</span>
        </div>
      </div>
    ),
    size,
  );
}
