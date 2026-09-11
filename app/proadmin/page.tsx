import { cookies } from "next/headers";
import { PROADMIN_COOKIE, verifySessionToken } from "@/lib/admin-auth";
import { AdminDashboard } from "@/components/admin-dashboard";
import AdminLogin from "@/components/admin-login";

export const dynamic = "force-dynamic";
export const metadata = { title: "floptools · pro admin", robots: { index: false, follow: false } };

/**
 * /proadmin — the pro admin panel. Same features as /admin, its own signed
 * cookie (floptools_proadmin) and its own login endpoint. The pass defaults to
 * the admin pass (Nur1@2@3) unless PROADMIN_PASSWORD overrides it.
 */
export default async function ProAdminPage() {
  const jar = await cookies();
  const session = jar.get(PROADMIN_COOKIE)?.value;
  const authed = verifySessionToken(session, "proadmin");

  return (
    <div className="mx-auto max-w-5xl px-4 pb-10 pt-12">
      {authed ? (
        <AdminDashboard
          statsEndpoint="/api/proadmin/stats"
          logoutEndpoint="/api/proadmin/logout"
        />
      ) : (
        <AdminLogin
          endpoint="/api/proadmin/login"
          title="Pro admin sign in"
          hint="Pro panel password (defaults to the admin password)."
        />
      )}
    </div>
  );
}
