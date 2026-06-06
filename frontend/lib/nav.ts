/**
 * Cockpit navigation model — the single source of truth for the primary nav and
 * the federated-surface placeholders. Lives in `lib/` (not in a component) so the
 * desktop rail (AppShell) and the mobile drawer (MobileNav) both import the exact
 * same set with no component↔component import cycle.
 */
import {
  LayoutDashboard, Users, Filter, Waypoints, Inbox,
  Receipt, Megaphone, Mail, Video, Bot, type LucideIcon,
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

/** A federated-surface placeholder (rendered inert until each app is wired in). */
export interface FederatedItem { label: string; icon: LucideIcon; gradient: string }

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard, exact: true, gradient: 'from-indigo-500 to-violet-500', bar: 'bg-violet-400' },
  { href: '/dashboard/leads', label: 'Ingestion', icon: Inbox, gradient: 'from-lime-400 to-emerald-500', bar: 'bg-emerald-400' },
  { href: '/dashboard/customers', label: 'Relationships', icon: Users, gradient: 'from-violet-500 to-fuchsia-500', bar: 'bg-fuchsia-400' },
  { href: '/dashboard/pipeline', label: 'Pipeline', icon: Filter, gradient: 'from-amber-400 to-orange-500', bar: 'bg-amber-400' },
  { href: '/dashboard/graph', label: 'Graph', icon: Waypoints, gradient: 'from-cyan-400 to-blue-500', bar: 'bg-cyan-400' },
];

export const FEDERATED: FederatedItem[] = [
  { label: 'Invoices', icon: Receipt, gradient: 'from-emerald-400 to-teal-500' },
  { label: 'Outreach', icon: Megaphone, gradient: 'from-fuchsia-500 to-pink-500' },
  { label: 'Email', icon: Mail, gradient: 'from-sky-400 to-blue-500' },
  { label: 'Meetings', icon: Video, gradient: 'from-teal-400 to-cyan-500' },
  { label: 'Agents', icon: Bot, gradient: 'from-violet-500 to-cyan-500' },
];

/** Is this nav item the active route? Shared by the rail + the mobile drawer. */
export function isNavActive(item: NavItem, pathname: string): boolean {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href);
}
