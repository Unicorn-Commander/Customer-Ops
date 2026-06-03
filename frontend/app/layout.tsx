import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Customer-Ops',
  description: 'The relationship / funnel cockpit of the Unicorn Commander suite.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
