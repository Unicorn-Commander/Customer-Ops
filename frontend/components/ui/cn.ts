import clsx, { type ClassValue } from 'clsx';

/** Tiny class combiner — the conventional `cn(...)` wrapper so primitives read
 *  cleanly. Primitives keep their class lists tight; callers append via the
 *  trailing `className`. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
