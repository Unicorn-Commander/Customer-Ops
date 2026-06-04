/**
 * Visual meta for the cockpit's colorful language: the funnel stage palette and
 * the per-feature icon hues. Class strings are written out in FULL (never
 * interpolated) so Tailwind's content scanner keeps them.
 */
import {
  Sparkles, TrendingUp, BadgeCheck, Users, Filter, Receipt, Megaphone, Mail,
  Video, Bot, type LucideIcon,
} from 'lucide-react';
import type { Stage } from '@/lib/customers';

export interface StageMeta {
  label: string;
  icon: LucideIcon;
  text: string;   // colored text
  well: string;   // tinted well background
  dot: string;    // solid dot / bar
  ring: string;   // focus/active ring
  grad: string;   // gradient (lane headers, hero)
}

export const STAGE_META: Record<Stage, StageMeta> = {
  LEAD: {
    label: 'Lead', icon: Sparkles,
    text: 'text-stage-lead', well: 'bg-stage-lead/12', dot: 'bg-stage-lead',
    ring: 'ring-stage-lead/40', grad: 'from-stage-lead/25 to-transparent',
  },
  PROSPECT: {
    label: 'Prospect', icon: TrendingUp,
    text: 'text-stage-prospect', well: 'bg-stage-prospect/12', dot: 'bg-stage-prospect',
    ring: 'ring-stage-prospect/40', grad: 'from-stage-prospect/25 to-transparent',
  },
  CUSTOMER: {
    label: 'Customer', icon: BadgeCheck,
    text: 'text-stage-customer', well: 'bg-stage-customer/12', dot: 'bg-stage-customer',
    ring: 'ring-stage-customer/40', grad: 'from-stage-customer/25 to-transparent',
  },
};

export interface FeatureMeta {
  key: string;
  label: string;
  href: string;
  icon: LucideIcon;
  text: string;
  well: string;
}

/** The cockpit modules — each with its own icon hue. Drives the nav + the
 *  customer-360 section headers. */
export const FEATURES: FeatureMeta[] = [
  { key: 'relationships', label: 'Relationships', href: '/dashboard/customers', icon: Users, text: 'text-feat-relationships', well: 'bg-feat-relationships/12' },
  { key: 'pipeline', label: 'Pipeline', href: '/dashboard/pipeline', icon: Filter, text: 'text-feat-pipeline', well: 'bg-feat-pipeline/12' },
  { key: 'invoices', label: 'Invoices', href: '/dashboard/customers', icon: Receipt, text: 'text-feat-invoices', well: 'bg-feat-invoices/12' },
  { key: 'outreach', label: 'Outreach', href: '/dashboard/customers', icon: Megaphone, text: 'text-feat-outreach', well: 'bg-feat-outreach/12' },
  { key: 'email', label: 'Email', href: '/dashboard/customers', icon: Mail, text: 'text-feat-email', well: 'bg-feat-email/12' },
  { key: 'meetings', label: 'Meetings', href: '/dashboard/customers', icon: Video, text: 'text-feat-meetings', well: 'bg-feat-meetings/12' },
  { key: 'agents', label: 'Agents', href: '/dashboard/customers', icon: Bot, text: 'text-feat-agents', well: 'bg-feat-agents/12' },
];
