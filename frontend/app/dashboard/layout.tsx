import { AppShell } from '@/components/AppShell';

/** Authenticated cockpit shell. AppShell owns the sidebar, topbar, theme, and
 *  the client-side auth gate (no token → /auth/login). */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
