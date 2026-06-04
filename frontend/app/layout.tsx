import type { Metadata } from 'next';
import './globals.css';
import './theme.css';

export const metadata: Metadata = {
  title: 'Customer-Ops — relationship cockpit',
  description: 'The relationship / funnel cockpit of the Unicorn Commander suite.',
};

// Set the theme attribute before first paint so there's no flash. Defaults to
// dark; ThemeToggle persists the user's choice in localStorage('co-theme').
const noFlash = `(function(){try{var t=localStorage.getItem('co-theme');if(t!=='light'&&t!=='dark')t='dark';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlash }} />
      </head>
      <body className="co-app min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
