/**
 * The public quote surface sits OUTSIDE the cockpit: no AppShell, no nav, no
 * auth redirect — a prospect who follows a share link is not a user of this
 * app and must never see a login wall or the product chrome.
 *
 * The root layout pins `data-theme="dark"` for the cockpit before first paint.
 * The document designs both themes on purpose and defaults to the reader's
 * system setting, so this layout clears that attribute (and re-applies the
 * reader's own saved choice) before the document paints.
 */

export const dynamic = 'force-dynamic';

const adoptReaderTheme = `(function(){try{var t=localStorage.getItem('q-theme');var r=document.documentElement;if(t==='light'||t==='dark'){r.setAttribute('data-theme',t)}else{r.removeAttribute('data-theme')}}catch(e){try{document.documentElement.removeAttribute('data-theme')}catch(e2){}}})();`;

export default function PublicQuoteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: adoptReaderTheme }} />
      {children}
    </>
  );
}
