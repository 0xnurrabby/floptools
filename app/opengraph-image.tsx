import { ImageResponse } from "next/og";

/**
 * Site-wide social preview card. Lives at the root, so every path shares this
 * card on X, Telegram, Discord and anywhere else that reads Open Graph tags.
 */

export const alt = "floptools · keep one did:key alive";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
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
            <div style={{ display: "flex", fontSize: 28, fontWeight: 700, color: "#0b0b0f" }}>floptools</div>
            <div style={{ display: "flex", fontSize: 20, color: "#52525b" }}>
              local · unofficial · keys stay on your device
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            style={{
              display: "flex",
              fontSize: 72,
              fontWeight: 800,
              color: "#0b0b0f",
              letterSpacing: -2,
              lineHeight: 1.05,
            }}
          >
            Keep one did:key alive
          </div>
          <div style={{ display: "flex", fontSize: 30, color: "#3f3f46", maxWidth: 980 }}>
            Create, sign, check, and deal with a single encrypted Ed25519 identity on Technocore.
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 10 }}>
            {["Create", "Sign", "Activity", "Deal", "Check", "Trustcore"].map((t) => (
              <div
                key={t}
                style={{
                  display: "flex",
                  background: "#ffffff",
                  border: "1px solid #e4e4e7",
                  borderRadius: 999,
                  padding: "10px 22px",
                  fontSize: 22,
                  color: "#18181b",
                }}
              >
                {t}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, color: "#71717a" }}>
          <span>floptools.nurlab.xyz</span>
          <span>no eligibility · no token · no faucet</span>
        </div>
      </div>
    ),
    {
      ...size,
      // Cache hard: crawlers should fetch the card once.
      headers: {
        "cache-control": "public, max-age=600, s-maxage=86400, stale-while-revalidate=604800",
      },
    },
  );
}
