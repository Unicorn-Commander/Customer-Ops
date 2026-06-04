/**
 * Representative sample data for the /preview route (no backend / no auth).
 * On-brand with the suite's leadgen reality (retirement 401(k), CRE, Northwind).
 */
import type { PipelineBoard } from './customers';
import type { AttentionItem, ActivityItem } from '@/components/dashboard/CockpitDashboard';
import type { GraphData } from '@/components/dashboard/KnowledgeGraph';

export const SAMPLE_BOARD: PipelineBoard = {
  lanes: [
    { stage: 'LEAD', count: 184, expectedValue: '124000', cards: [] },
    { stage: 'PROSPECT', count: 47, expectedValue: '286000', cards: [] },
    { stage: 'CUSTOMER', count: 12, expectedValue: '240000', cards: [] },
  ],
  totals: { count: 243, expectedValue: '410000' },
};

export const SAMPLE_ATTENTION: AttentionItem[] = [
  { id: '1', name: 'Morgan Ali — Irving TX 401(k)', stage: 'PROSPECT', priority: 'HIGH', note: 'Follow-up overdue 3 days' },
  { id: '2', name: 'Bayview Health — Frisco', stage: 'PROSPECT', priority: 'HIGH', note: 'Proposal sent · awaiting signature' },
  { id: '3', name: 'Coastal Property Group', stage: 'LEAD', priority: 'HIGH', note: 'Hot CRE lead · no outreach yet' },
  { id: '4', name: 'Victor Lang', stage: 'LEAD', priority: 'MEDIUM', note: 'Enriched · ready to triage' },
  { id: '5', name: 'Sunrise Dental', stage: 'PROSPECT', priority: 'MEDIUM', note: 'Next action due today' },
];

export const SAMPLE_ACTIVITY: ActivityItem[] = [
  { id: 'a1', name: 'Northwind Remodeling', stage: 'CUSTOMER', text: 'converted to customer — $42k won', when: '12m ago' },
  { id: 'a2', name: 'Morgan Ali', stage: 'PROSPECT', text: 'moved to prospect after a reply', when: '1h ago' },
  { id: 'a3', name: 'Coastal Property Group', stage: 'LEAD', text: 'sourced from the LoopNet scrape', when: '2h ago' },
  { id: 'a4', name: 'Maple Street Dental', stage: 'PROSPECT', text: 'opened the outreach email 3×', when: '4h ago' },
  { id: 'a5', name: 'Victor Lang', stage: 'LEAD', text: 'enriched · email verified', when: 'Yesterday' },
  { id: 'a6', name: 'Sunrise Dental', stage: 'CUSTOMER', text: 'invoice #1042 marked paid', when: 'Yesterday' },
];

export const SAMPLE_GRAPH: GraphData = {
  nodes: [
    { id: 'hub', label: 'Your book', type: 'hub' },
    { id: 'o1', label: 'Bayview Health', type: 'org', stage: 'PROSPECT', weight: 3 },
    { id: 'o2', label: 'Coastal Property', type: 'org', stage: 'LEAD', weight: 2 },
    { id: 'o3', label: 'Northwind Remodeling', type: 'org', stage: 'CUSTOMER', weight: 3 },
    { id: 'o4', label: 'Frisco Dental', type: 'org', stage: 'PROSPECT', weight: 2 },
    { id: 'o5', label: 'Irving 401(k)', type: 'org', stage: 'LEAD', weight: 2 },
    { id: 'o6', label: 'Sunrise Dental', type: 'org', stage: 'CUSTOMER', weight: 2 },
    { id: 'p1', label: 'Maya Hart', type: 'person', stage: 'PROSPECT' },
    { id: 'p2', label: 'Morgan Ali', type: 'person', stage: 'LEAD' },
    { id: 'p3', label: 'Victor Lang', type: 'person', stage: 'LEAD' },
    { id: 'p4', label: 'D. Chen', type: 'person', stage: 'CUSTOMER' },
    { id: 'p5', label: 'R. Patel', type: 'person', stage: 'PROSPECT' },
    { id: 'p6', label: 'S. Nguyen', type: 'person', stage: 'CUSTOMER' },
    { id: 'p7', label: 'J. Romero', type: 'person', stage: 'PROSPECT' },
    { id: 'p8', label: 'A. Brooks', type: 'person', stage: 'LEAD' },
  ],
  edges: [
    { from: 'hub', to: 'o1' }, { from: 'hub', to: 'o2' }, { from: 'hub', to: 'o3' },
    { from: 'hub', to: 'o4' }, { from: 'hub', to: 'o5' }, { from: 'hub', to: 'o6' },
    { from: 'o1', to: 'p1' }, { from: 'o1', to: 'p5' }, { from: 'o5', to: 'p2' },
    { from: 'o2', to: 'p3' }, { from: 'o2', to: 'p8' }, { from: 'o3', to: 'p4' },
    { from: 'o3', to: 'p6' }, { from: 'o4', to: 'p7' },
  ],
};
