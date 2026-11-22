import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * AUD-CR-6: customer-visible strings in the cockpit name no internal component
 * or state. The frontend has no test runner, so this backend spec (jest
 * testRegex .*\.spec\.ts$) reads the frontend sources directly, like
 * quotes-render/mirror.spec.ts does.
 *
 * Only VISIBLE text is checked: JSX text and string/template literals, with
 * comments, imports, identifiers and api/route paths left alone. Product names
 * of sibling apps a customer buys ("Customer-Ops and Outreach on your plan")
 * are allowed only in the entitlement notices; anything that reads as an
 * internal component, engine or state is not.
 */
const FRONTEND = join(__dirname, '..', '..', '..', 'frontend');

const FILES = [
  'components/dashboard/customer360/EmailPanel.tsx',
  'components/dashboard/customer360/ContactCard.tsx',
  'components/dashboard/customer360/Header.tsx',
  'components/dashboard/customer360/shared.tsx',
  'components/dashboard/customer360/OutreachPanel.tsx',
  'components/dashboard/customer360/InvoicesPanel.tsx',
  'components/dashboard/customer360/MeetingsPanel.tsx',
  'components/dashboard/customer360/ProjectsPanel.tsx',
  'components/dashboard/customer360/ConversationsPanel.tsx',
  'components/dashboard/customer360/AgentsPanel.tsx',
  'components/dashboard/RelationshipsTable.tsx',
  'components/dashboard/LeadIngestion.tsx',
  'components/dashboard/CockpitDashboard.tsx',
  'app/dashboard/agents/page.tsx',
];

/** Internal component names, engines and states a customer must not see. */
const INTERNAL =
  /\b(Contact-Ops|Email-Ops|Meeting-Ops|Project-Ops|Conversations-Ops|Accounting-Ops|Stalwart|Listmonk|Postiz|UUDC|federat\w*|dormant|AR engine)\b/i;

/** Allowed: plan/entitlement notices naming the products a customer buys. */
const PLAN_NOTICE = /on your plan/;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Visible text: JSX text between tags, and quoted / template string literals. */
function visibleStrings(src: string): string[] {
  const body = stripComments(src)
    .split('\n')
    .filter((l) => !/^\s*import\s/.test(l))
    .join('\n');
  const out: string[] = [];
  for (const m of body.matchAll(/>([^<>{}]+)</g)) out.push(m[1].trim());
  for (const m of body.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) {
    // A literal compared against an API value (via === 'contact-ops') is not shown.
    if (/[=!]==\s*$/.test(body.slice(0, m.index))) continue;
    out.push((m[1] ?? m[2] ?? m[3] ?? '').trim());
  }
  // Single bare words are identifiers; hyphenated tokens are kept, since a
  // prop like source="meeting-ops" renders upper-cased in the SourceTag.
  return out.filter((s) => s && !/^[./@]|^api\/|^\/|^\w+$/.test(s));
}

const present = existsSync(FRONTEND);
(present ? describe : describe.skip)(
  'customer-visible copy names no internal component (AUD-CR-6)',
  () => {
    it.each(FILES)('%s', (rel) => {
      const src = readFileSync(join(FRONTEND, rel), 'utf8');
      const hits = visibleStrings(src).filter((s) => INTERNAL.test(s) && !PLAN_NOTICE.test(s));
      expect(hits).toEqual([]);
    });

    it('the lead-linking toast is singular for one lead', () => {
      const src = readFileSync(join(FRONTEND, 'components/dashboard/LeadIngestion.tsx'), 'utf8');
      expect(src).not.toMatch(/linked \$\{res\.provisionalUpgraded\} saved leads to contacts/);
      expect(src).toMatch(/res\.provisionalUpgraded === 1 \? 'lead' : 'leads'/);
    });
  },
);
