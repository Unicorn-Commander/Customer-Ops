'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/dashboard', label: 'Overview', exact: true },
  { href: '/dashboard/customers', label: 'Relationships', exact: false },
  { href: '/dashboard/pipeline', label: 'Pipeline', exact: false },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="co-nav">
      {LINKS.map((l) => {
        const active = l.exact ? pathname === l.href : pathname.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} className={active ? 'is-active' : ''}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
