/**
 * Cockpit navigation model — the single source of truth for the primary nav.
 * Lives in `lib/` (not in a component) so the desktop rail (AppShell) and the
 * mobile drawer (MobileNav) both import the exact same set with no
 * component↔component import cycle.
 */
import {
  LayoutDashboard, Users, Filter, Waypoints, Inbox,
  Bot, Settings, LifeBuoy, type LucideIcon,
} from 'lucide-react';

/** A primary cockpit nav entry. */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  /** Two-stop gradient for the entry's IconTile, e.g. "from-indigo-500 to-violet-500". */
  gradient: string;
  /** The active-rail accent bar color, e.g. "bg-violet-400". */
  bar: string;
}

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard, exact: true, gradient: 'from-indigo-500 to-violet-500', bar: 'bg-violet-400' },
  { href: '/dashboard/leads', label: 'Ingestion', icon: Inbox, gradient: 'from-lime-400 to-emerald-500', bar: 'bg-emerald-400' },
  { href: '/dashboard/customers', label: 'Relationships', icon: Users, gradient: 'from-violet-500 to-fuchsia-500', bar: 'bg-fuchsia-400' },
  { href: '/dashboard/pipeline', label: 'Pipeline', icon: Filter, gradient: 'from-amber-400 to-orange-500', bar: 'bg-amber-400' },
  { href: '/dashboard/graph', label: 'Graph', icon: Waypoints, gradient: 'from-cyan-400 to-blue-500', bar: 'bg-cyan-400' },
  { href: '/dashboard/agents', label: 'Agents', icon: Bot, gradient: 'from-violet-500 to-cyan-500', bar: 'bg-cyan-400' },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings, gradient: 'from-slate-400 to-slate-600', bar: 'bg-slate-400' },
  { href: '/dashboard/help', label: 'Help', icon: LifeBuoy, gradient: 'from-fuchsia-500 to-pink-500', bar: 'bg-fuchsia-400' },
];

/** Is this nav item the active route? Shared by the rail + the mobile drawer. */
export function isNavActive(item: NavItem, pathname: string): boolean {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href);
}
