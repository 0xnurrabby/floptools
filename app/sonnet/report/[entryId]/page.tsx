import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { SonnetReportBody } from "@/components/sonnet-voter-report";
import { entryVoterReport, type VoterReport } from "@/lib/sonnet";

export const dynamic = "force-dynamic";

const ENTRY_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ entryId: string }>;
}): Promise<Metadata> {
  const { entryId } = await params;
  const id = entryId.toLowerCase();
  if (!ENTRY_RE.test(id)) return { title: "Sonnet voters & rug report" };
  try {
    const report = await entryVoterReport(id);
    const title = `${report.gameId ?? id} · ${report.votes} voter${report.votes === 1 ? "" : "s"} · risk ${report.risk.score}/100`;
    const description = report.risk.summary.slice(0, 300);
    return {
      title,
      description,
      openGraph: { title, description, type: "article" },
      twitter: { card: "summary_large_image", title, description },
    };
  } catch {
    return { title: "Sonnet voters & rug report" };
  }
}

export default async function SonnetReportPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
}) {
  const { entryId } = await params;
  const id = entryId.toLowerCase();
  if (!ENTRY_RE.test(id)) notFound();

  let report: VoterReport | null = null;
  try {
    report = await entryVoterReport(id);
  } catch {
    report = null;
  }

  const hdrs = await headers();
  const host = hdrs.get("x-forwarded-host") ?? "floptools.nurlab.xyz";
  const proto = hdrs.get("x-forwarded-proto") ?? "https";
  const shareUrl = `${proto}://${host}/sonnet/report/${encodeURIComponent(id)}`;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-10 pt-12">
      <Link
        href="/sonnet/top-sonnet"
        className="caption-sm text-body underline decoration-hairline-strong underline-offset-2 hover:text-ink"
      >
        ← Top Sonnet
      </Link>
      <div className="mt-5 rounded-[18px] border border-hairline bg-canvas p-5 sm:p-6">
        <SonnetReportBody
          entryId={id}
          gameId={report?.gameId ?? null}
          votes={report?.votes ?? 0}
          initial={report}
          shareUrl={shareUrl}
        />
      </div>
    </div>
  );
}
