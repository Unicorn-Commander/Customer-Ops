'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { cn } from './ui/cn';

type Theme = 'light' | 'dark';

/** Theme toggle — flips the <html data-theme> attribute and persists it. The
 *  no-flash script in the root layout reads the same key on load. */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const t = (document.documentElement.getAttribute('data-theme') as Theme) || 'dark';
    setTheme(t);
  }, []);

  const flip = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('co-theme', next);
    } catch {
      /* ignore */
    }
    setTheme(next);
  };

  const Icon = theme === 'dark' ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={flip}
      aria-label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
      className={cn(
        'grid h-9 w-9 place-items-center rounded-token border border-subtle bg-surface-raised text-tertiary',
        'transition-colors duration-fast ease-token hover:text-primary hover:bg-surface-overlay',
        className,
      )}
    >
      <Icon className="h-[18px] w-[18px]" strokeWidth={2.25} />
    </button>
  );
}
