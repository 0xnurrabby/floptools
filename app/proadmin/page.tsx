import { cookies } from "next/headers";
import { PROADMIN_COOKIE, verifySessionToken } from "@/lib/admin-auth";
import { ProAdminDashboard } from "@/components/proadmin-dashboard";
import AdminLogin from "@/components/admin-login";

export const dynamic = "force-dynamic";
export const metadata = { title: "floptools · pro admin", robots: { index: false, follow: false } };

/**
 * /proadmin — the Pro panel: Pro-mode tracking only (unlocks, failures, locks,
 * limit bypasses). Its own signed cookie (floptools_proadmin) and login
 * endpoint; the app-wide stats stay on /admin, deliberately unmixed.
 */
export default async function ProAdminPage() {
  const jar = await cookies();
  const session = jar.get(PROADMIN_COOKIE)?.value;
  const authed = verifySessionToken(session, "proadmin");

  return (
    <div className="mx-auto max-w-5xl px-4 pb-10 pt-12">
      {authed ? (
        <ProAdminDashboard />
      ) : (
        <AdminLogin
          endpoint="/api/proadmin/login"
          title="Pro panel sign in"
          hint="Pro panel password (defaults to the admin password)."
        />
      )}
    </div>
  );
}
