import { cookies } from "next/headers";
import { PRO_COOKIE, proConfigured, verifyProToken } from "@/lib/pro-auth";
import { ProLogin } from "@/components/pro-login";
import { ProPanel } from "@/components/pro-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "floptools · pro", robots: { index: false, follow: false } };

/**
 * /pro — secret panel. The gate is server-side: the signed HttpOnly cookie is
 * the only way in, and it can only be minted by the passcode check. Nothing
 * here reveals whether a passcode exists beyond "configured / not configured".
 */
export default async function ProPage() {
  const jar = await cookies();
  const pro = verifyProToken(jar.get(PRO_COOKIE)?.value);

  return (
    <div className="mx-auto max-w-3xl px-4 pb-10 pt-12">
      {pro ? <ProPanel /> : <ProLogin configured={proConfigured()} />}
    </div>
  );
}
