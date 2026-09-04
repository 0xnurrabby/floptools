import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/admin-auth";
import { AdminDashboard } from "@/components/admin-dashboard";
import AdminLogin from "@/components/admin-login";

export const metadata = { title: "floptools · admin", robots: { index: false, follow: false } };

export default async function AdminPage() {
  const jar = await cookies();
  const session = jar.get(ADMIN_COOKIE)?.value;
  const authed = verifySessionToken(session);

  return (
    <div className="mx-auto max-w-5xl px-4 pb-10 pt-12">
      {authed ? (
        <AdminDashboard />
      ) : (
        <AdminLogin />
      )}
    </div>
  );
}