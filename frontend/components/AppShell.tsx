'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Search, Plus, LogOut, PanelLeftClose, PanelLeftOpen, Menu,
} from 'lucide-react';
import { getToken, getStoredUser, clearSession, type CustomerOpsUser } from '@/lib/api';
import { useWorkspace } from '@/lib/useWorkspace';
import { NAV, isNavActive } from '@/lib/nav';
import { ThemeToggle } from './ThemeToggle';
import { CommandPalette } from './CommandPalette';
import { MobileNav } from './MobileNav';
import { HelpCenter } from './help/HelpCenter';
import { IconTile } from './ui/IconTile';
import { cn } from './ui/cn';

const DEMO_USER: CustomerOpsUser = { id: 'demo', email: 'demo@example.com', username: 'aaron', firstName: 'Aaron', lastName: 'Stransky' };

function titleFor(pathname: string): { title: string; sub: string } {
  if (pathname.startsWith('/dashboard/leads')) return { title: 'Lead Ingestion', sub: 'The intake firehose for the lead pipeline' };
  if (pathname.startsWith('/dashboard/customers')) return { title: 'Relationships', sub: 'Every contact, by lifecycle stage' };
  if (pathname.startsWith('/dashboard/pipeline')) return { title: 'Pipeline', sub: 'Lead → Prospect → Customer' };
  if (pathname.startsWith('/dashboard/graph')) return { title: 'Knowledge graph', sub: 'People, orgs & deals as a living network' };
  if (pathname.startsWith('/dashboard/agents')) return { title: 'Relations Officer', sub: 'Every relationship, connected' };
  if (pathname.startsWith('/dashboard/invoices')) return { title: 'Invoices', sub: 'Every invoice across your workspace' };
  if (pathname.startsWith('/dashboard/email')) return { title: 'Email', sub: 'Every send & draft across your workspace' };
  if (pathname.startsWith('/dashboard/outreach')) return { title: 'Outreach', sub: 'Every campaign touch across your workspace' };
  if (pathname.startsWith('/dashboard/settings')) return { title: 'Settings', sub: 'Configure your cockpit & its connections' };
  if (pathname.startsWith('/dashboard/help')) return { title: 'Help', sub: 'The complete guide to your cockpit' };
  return { title: 'Overview', sub: 'Your relationship cockpit at a glance' };
}

export function AppShell({ children, demo = false }: { children: React.ReactNode; demo?: boolean }) {
  const router = useRouter();
  const { canWrite } = useWorkspace(!demo);
  const pathname = usePathname() || '/dashboard';
  const [ready, setReady] = useState(demo);
  const [user, setUser] = useState<CustomerOpsUser | null>(demo ? DEMO_USER : null);
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    try { setCollapsed(localStorage.getItem('co-sidebar') === 'collapsed'); } catch { /* ignore */ }
  }, []);

  // Global ⌘K / Ctrl+K (and "/" when not typing) toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmdK = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.isContentEditable
        || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
      const slash = e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (cmdK || slash) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  // Dismiss the mobile drawer on navigation (a tap that changes the route).
  useEffect(() => { setMobileNavOpen(false); }, [pathname]);
  useEffect(() => {
    if (demo) return;
    if (!getToken()) { router.replace('/auth/login'); return; }
    setUser(getStoredUser<CustomerOpsUser>());
    setReady(true);
  }, [router, demo]);

  const { title, sub } = useMemo(() => titleFor(pathname), [pathname]);
  const initials = (user ? `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}` : '··').toUpperCase();

  const toggleCollapsed = () => setCollapsed((c) => {
    const next = !c;
    try { localStorage.setItem('co-sidebar', next ? 'collapsed' : 'open'); } catch { /* ignore */ }
    return next;
  });
  const signOut = () => { clearSession(); router.replace('/auth/login'); };

  if (!ready) {
    return (
      <div className="grid min-h-screen place-items-center bg-surface-base">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-surface-base text-secondary">
      {/* ---- Sidebar ---- */}
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-subtle bg-surface-base/70 px-3 py-4 backdrop-blur-xl transition-[width] duration-200 ease-token md:flex',
          collapsed ? 'w-[72px] items-center' : 'w-[252px]',
        )}
      >
        {/* Brand */}
        <Link href="/dashboard" className={cn('relative mb-5 flex items-center gap-2.5', collapsed ? 'justify-center px-0' : 'px-2')}>
          <span aria-hidden className="co-glow absolute -left-1 -top-1 h-10 w-10" />
          <img
            src="/brand-mark.png"
            alt="Customer-Ops"
            className="relative h-9 w-9 rounded-[11px] shadow-glow"
          />
          {!collapsed && (
            <span className="relative text-[15px] font-semibold tracking-tight">
              <span className="co-wordmark">Customer</span><span className="text-tertiary">-Ops</span>
            </span>
          )}
        </Link>

        {/* Primary nav */}
        <nav className={cn('flex flex-col gap-1', collapsed && 'w-full items-center')}>
          {NAV.map((item) => {
            const active = isNavActive(item, pathname);
            return (
              <Fragment key={item.href}>
                {/* Section divider/label — keeps the rail scannable as it grows.
                    Collapsed: a hairline rule; expanded: a small uppercase label. */}
                {item.groupLabel && (
                  collapsed ? (
                    <span aria-hidden className="my-1.5 h-px w-7 bg-[rgb(var(--co-edge))]/70" />
                  ) : (
                    <span className="mb-1 mt-3 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                      {item.groupLabel}
                    </span>
                  )
                )}
                <Link
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    'group relative flex items-center rounded-token transition-colors duration-fast ease-token',
                    collapsed ? 'h-11 w-11 justify-center' : 'gap-3 px-2.5 py-2',
                    active ? 'bg-surface-overlay' : 'hover:bg-surface-raised',
                  )}
                >
                  {active && !collapsed && <span className={cn('absolute left-0 top-1.5 h-[calc(100%-12px)] w-[3px] rounded-full', item.bar)} />}
                  <IconTile icon={item.icon} gradient={item.gradient} size="sm" />
                  {!collapsed && (
                    <span className={cn('text-sm', active ? 'font-semibold text-primary' : 'font-medium text-primary/85 group-hover:text-primary')}>
                      {item.label}
                    </span>
                  )}
                </Link>
              </Fragment>
            );
          })}
        </nav>

        <div className="mt-auto w-full" />

        {/* Collapse toggle */}
        <button
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
          className={cn(
            'mb-2 flex items-center rounded-token text-tertiary transition-colors hover:bg-surface-raised hover:text-primary',
            collapsed ? 'h-10 w-10 justify-center' : 'gap-2.5 px-2.5 py-2 text-xs',
          )}
        >
          {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" strokeWidth={2.25} /> : <><PanelLeftClose className="h-[18px] w-[18px]" strokeWidth={2.25} /> Collapse</>}
        </button>

        {/* User */}
        <div className={cn('flex items-center rounded-token border border-subtle bg-surface-raised', collapsed ? 'h-11 w-11 justify-center' : 'gap-2.5 p-2.5')}>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-fuchsia text-xs font-bold text-white">{initials}</span>
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-primary">{user?.firstName} {user?.lastName}</div>
                <div className="truncate text-[11px] text-tertiary">{user?.email}</div>
              </div>
              <button onClick={signOut} aria-label="Sign out" className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-danger">
                <LogOut className="h-4 w-4" strokeWidth={2.25} />
              </button>
            </>
          )}
        </div>
      </aside>

      {/* ---- Main column ---- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-subtle bg-surface-base/80 px-4 py-3 backdrop-blur-xl sm:px-5 sm:gap-4">
          <div className="flex min-w-0 items-center gap-2.5">
            {/* Mobile: open the nav drawer (the rail is hidden below md). */}
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation"
              aria-haspopup="dialog"
              className="-ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-token border border-subtle bg-surface-raised text-tertiary transition-colors duration-fast ease-token hover:text-primary hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 md:hidden"
            >
              <Menu className="h-[18px] w-[18px]" strokeWidth={2.25} />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold text-primary">{title}</h1>
              <p className="truncate text-xs text-tertiary">{sub}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-haspopup="dialog"
              aria-keyshortcuts="Meta+K Control+K"
              className="hidden items-center gap-2 rounded-token border border-subtle bg-surface-raised px-3 py-2 text-xs text-tertiary transition-colors hover:text-primary sm:flex"
            >
              <Search className="h-4 w-4" strokeWidth={2.25} /><span>Search</span>
              <kbd className="ml-1 rounded border border-subtle bg-surface-overlay px-1.5 py-0.5 font-mono text-[10px] text-muted">⌘K</kbd>
            </button>
            <HelpCenter pathname={pathname} disableFirstRun={demo} />
            <ThemeToggle />
            {(demo || canWrite) && <Link
              href="/dashboard/customers"
              aria-label="New relationship"
              className="inline-flex items-center gap-1.5 rounded-token bg-accent px-2.5 py-2 text-xs font-semibold text-accent-contrast shadow-glow transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:px-3"
            >
              <Plus className="h-4 w-4" strokeWidth={2.5} /> <span className="hidden sm:inline">New</span>
            </Link>}
          </div>
        </header>

        <main className="co-ambient co-ambient-grid flex-1 px-4 py-5 sm:px-5 sm:py-6">{children}</main>
      </div>

      {/* ⌘K command palette — portaled to <body>, opened from the topbar search
          button or the global keyboard shortcut. */}
      <CommandPalette open={paletteOpen} onClose={closePalette} />

      {/* Mobile navigation drawer — the rail is hidden below md, so this is the
          only way to move between cockpit sections on a phone. */}
      <MobileNav
        open={mobileNavOpen}
        onClose={closeMobileNav}
        pathname={pathname}
        user={user}
        onSignOut={signOut}
      />
    </div>
  );
}
