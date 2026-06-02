import { redirect } from "next/navigation";

import { BrandMark } from "@/components/brand-mark";
import { ensureOrgAndProfile } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

import { AccountFooter } from "./account-footer";
import { PageTitle } from "./page-title";
import { SidebarNav } from "./sidebar-nav";

export default async function AppLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  // Middleware already gates these routes, but re-check so types narrow and we
  // never render the shell for an anonymous request.
  if (!user) {
    redirect("/login");
  }

  const email = user.email ?? "";

  // Signup side-effect: idempotently provision the org + profile on the first
  // authenticated load (covers the email-confirmation flow where signup
  // didn't yield a session).
  const { orgName } = await ensureOrgAndProfile({ userId: user.id, email });

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <div style={{ lineHeight: 1.1 }}>
            <div className="brand-name">AgentRouter</div>
            <div className="brand-sub">control plane</div>
          </div>
        </div>

        <SidebarNav />

        <div className="spacer" />

        <AccountFooter email={email} orgName={orgName} />
      </aside>

      <div className="main">
        <header className="topbar">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="crumbs">
              <span>{orgName}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <PageTitle />
            </div>
          </div>
        </header>

        <div className="content">{children}</div>
      </div>
    </div>
  );
}
