/**
 * The quote document stylesheet. Tokens (`--q-*`) are emitted by
 * brand-ops/brand-tokens.ts ahead of this sheet; this file only consumes them.
 *
 * Typographic system: a display serif for the masthead, section numerals,
 * figures and the folio; a humanist sans for running text at 65ch; a mono for
 * labels (letter-spaced caps) and money (tabular). Ruled tables, no cards
 * except the option heads, square corners, one strong black block button.
 */

export const DOCUMENT_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
.q-body{margin:0;background:var(--q-paper);color:var(--q-ink);font-family:var(--q-font-body);font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;font-feature-settings:"kern","liga"}
.q-page{max-width:1120px;margin:0 auto;padding:clamp(18px,3.5vw,44px) clamp(16px,4vw,52px) 140px}
h1,h2,h3,h4{font-family:var(--q-font-display);font-weight:400;margin:0;text-wrap:balance;letter-spacing:-0.005em}
.q-h1{font-size:clamp(36px,5.2vw,64px);line-height:1.02}
.q-h2{font-size:clamp(27px,3.2vw,36px);line-height:1.12}
.q-h3{font-size:21px;line-height:1.25;margin:26px 0 8px}
.q-h4{font-size:18px;line-height:1.3;margin:18px 0 6px}
p{margin:0 0 12px}
ul,ol{margin:0 0 14px;padding-left:22px}
li{margin:0 0 6px}
ul{list-style:square}
li::marker{color:var(--q-accent-ink)}
strong{font-weight:600}
em{font-style:italic}
code{font-family:var(--q-font-mono);font-size:.92em}
a{color:var(--q-accent-ink);text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
a:hover{color:var(--q-ink)}
:focus-visible{outline:2px solid var(--q-accent);outline-offset:3px;border-radius:2px}
.q-prose{max-width:65ch}
.q-prose p{text-wrap:pretty}
.q-label{font-family:var(--q-font-mono);font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--q-muted);font-weight:500}
.q-num{font-family:var(--q-font-mono);font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.q-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.q-tablewrap{overflow-x:auto;margin:14px 0 18px}

/* ---- toolbar (web only) ---- */
.q-toolbar{display:flex;justify-content:flex-end;gap:18px;align-items:center;font-size:13px;margin-bottom:22px;flex-wrap:wrap}
.q-toolbar a{text-decoration:none;font-family:var(--q-font-mono);font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--q-muted)}
.q-toolbar a:hover{color:var(--q-ink)}
.q-toolbar-sep{flex:1 1 0;min-width:0;order:-1}
.q-theme{display:inline-flex;border:1px solid var(--q-rule);order:-2;margin-right:auto}
.q-theme button{font:inherit;font-family:var(--q-font-mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;background:transparent;color:var(--q-muted);border:0;border-right:1px solid var(--q-rule);padding:6px 11px;cursor:pointer;min-height:32px}
.q-theme button:last-child{border-right:0}
.q-theme button[aria-pressed="true"]{background:var(--q-ink);color:var(--q-paper)}
.q-theme button:hover{color:var(--q-ink)}
.q-theme button[aria-pressed="true"]:hover{color:var(--q-paper)}

/* ---- notices / stamps ---- */
.q-notice{border:1px solid var(--q-proposed);border-left-width:6px;background:var(--q-surface);padding:14px 18px;margin:0 0 26px;display:flex;flex-wrap:wrap;gap:6px 24px;align-items:baseline;font-size:15px}
.q-notice.is-ok{border-color:var(--q-ok)}
.q-notice.is-muted{border-color:var(--q-muted)}
.q-notice strong{font-family:var(--q-font-mono);font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;font-weight:500}
.q-stamp{display:inline-block;font-family:var(--q-font-mono);font-size:12px;letter-spacing:.22em;text-transform:uppercase;border:2px solid var(--q-proposed);color:var(--q-proposed);padding:7px 14px 6px;transform:rotate(-5deg);transform-origin:center;white-space:nowrap}
.q-stamp.is-ok{border-color:var(--q-ok);color:var(--q-ok)}
.q-stamp.is-muted{border-color:var(--q-muted);color:var(--q-muted)}

/* ---- letterhead ---- */
.q-letterhead{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px 40px;align-items:end;padding-bottom:16px;border-bottom:3px double var(--q-rule-strong)}
.q-vendor-name{font-family:var(--q-font-display);font-size:26px;line-height:1.08}
.q-vendor-lines{color:var(--q-muted);font-size:13.5px;line-height:1.45;margin-top:6px}
.q-vendor-lines span{display:block}
.q-meta{margin:0;display:grid;grid-template-columns:auto auto;gap:3px 18px;font-size:13.5px;justify-content:end}
.q-meta dt{font-family:var(--q-font-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--q-muted);text-align:right;align-self:baseline}
.q-meta dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
.q-folio{font-family:var(--q-font-display);font-style:italic;font-size:clamp(30px,3.6vw,44px);line-height:1;text-align:right;margin-bottom:10px;letter-spacing:-0.01em}

/* ---- masthead ---- */
.q-masthead{padding:40px 0 30px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px 48px;align-items:start}
.q-eyebrow{color:var(--q-accent-ink);margin-bottom:16px}
.q-lede{font-size:18.5px;line-height:1.52;max-width:62ch;margin-top:22px}
.q-lede p{text-wrap:pretty}
.q-masthead-side{padding-top:14px;display:grid;gap:14px;justify-items:end}
.q-prepared{font-size:13.5px;color:var(--q-muted);text-align:right;line-height:1.45}
.q-prepared strong{display:block;color:var(--q-ink);font-weight:500}

/* ---- ledger strip (live totals) ---- */
.q-ledger{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--q-rule-strong);border-bottom:1px solid var(--q-rule);margin:6px 0 44px}
.q-ledger>div{padding:16px 20px 15px 0;border-left:1px solid var(--q-rule);padding-left:20px;min-width:0}
.q-ledger>div:first-child{border-left:0;padding-left:0}
.q-fig{font-family:var(--q-font-display);font-size:clamp(30px,3.2vw,40px);line-height:1;margin:10px 0 7px;font-variant-numeric:tabular-nums;letter-spacing:-0.01em;white-space:nowrap}
.q-fig small{font-family:var(--q-font-mono);font-size:12px;letter-spacing:.06em;color:var(--q-muted);margin-left:5px;font-style:normal}
.q-fig-note{font-size:13px;color:var(--q-muted);line-height:1.4}
.q-live{box-shadow:inset 0 -2px 0 var(--q-accent-soft)}

/* ---- sections ---- */
.q-section{display:grid;grid-template-columns:64px minmax(0,1fr);gap:8px 28px;padding:38px 0 30px;border-top:1px solid var(--q-rule)}
.q-doc.has-studio .q-section{grid-template-columns:64px minmax(0,1fr) 250px}
.q-section-no{font-family:var(--q-font-display);font-style:italic;font-size:46px;line-height:.9;color:var(--q-accent);padding-top:4px;letter-spacing:-0.02em}
.q-section-main{min-width:0}
.q-section-head{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:baseline;margin-bottom:14px}
.q-aside{border-left:6px solid transparent;border-image:repeating-linear-gradient(135deg,var(--q-proposed) 0 4px,transparent 4px 8px) 1;padding-left:14px;font-size:13.5px;color:var(--q-muted);line-height:1.5}
.q-aside .q-label{color:var(--q-proposed);display:block;margin-bottom:8px}
.q-aside p{margin-bottom:10px}
.q-body-md{margin-bottom:8px}

/* ---- markdown tables ---- */
.q-md-table{width:100%;border-collapse:collapse;font-size:14.5px}
.q-md-table th{text-align:left;font-family:var(--q-font-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--q-muted);font-weight:500;padding:0 14px 9px 0;border-bottom:1px solid var(--q-rule-strong)}
.q-md-table td{padding:9px 14px 9px 0;border-bottom:1px solid var(--q-rule);vertical-align:top}
.q-md-table .q-md-last{color:var(--q-muted);white-space:nowrap;width:1%}

/* ---- pills ---- */
.q-pill{display:inline-block;font-family:var(--q-font-mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;border:1px solid var(--q-rule);border-radius:999px;padding:3px 9px 2px;color:var(--q-muted);vertical-align:middle;line-height:1.2;white-space:nowrap}
.q-pill.agreed{border-color:var(--q-ok);color:var(--q-ok)}
.q-pill.proposed{border-color:var(--q-proposed);color:var(--q-proposed)}

/* ---- lines table ---- */
.q-lines{width:100%;border-collapse:collapse;margin:16px 0 8px;font-size:15px}
.q-lines th{text-align:left;font-family:var(--q-font-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--q-muted);font-weight:500;padding:0 12px 9px 0;border-bottom:1px solid var(--q-rule-strong)}
.q-lines td{padding:13px 12px 13px 0;border-bottom:1px solid var(--q-rule);vertical-align:top}
.q-lines th.q-amt,.q-lines td.q-amt{text-align:right;white-space:nowrap;padding-right:0;font-family:var(--q-font-mono);font-size:14px;font-variant-numeric:tabular-nums}
.q-lines td.q-amt{padding-top:15px}
.q-lines th.q-dim,.q-lines td.q-dim{text-align:right;white-space:nowrap;color:var(--q-muted);font-family:var(--q-font-mono);font-size:13px;font-variant-numeric:tabular-nums;width:1%}
.q-line-label{font-weight:500}
.q-line-desc{color:var(--q-muted);font-size:14px;margin-top:4px;max-width:62ch;line-height:1.5}
.q-line-desc p{margin:0 0 6px}
.q-line-disc{display:block;color:var(--q-muted);font-size:12px;margin-top:3px}
.q-lines tbody.q-keep{break-inside:avoid;page-break-inside:avoid}
.q-lines tr.q-total td{border-top:1px solid var(--q-rule-strong);border-bottom:0;font-weight:600;padding-top:13px}
.q-lines tr.q-total td.q-amt{font-size:16px}
.q-terms-list{display:grid;gap:10px;margin:14px 0 4px;padding:0;list-style:none}
.q-terms-list li{display:grid;grid-template-columns:20px minmax(0,1fr);gap:12px;font-size:14.5px;line-height:1.5;max-width:65ch}
.q-terms-list li::before{content:"";width:8px;height:8px;margin-top:8px;background:var(--q-accent);justify-self:center}
.q-terms-list.is-excluded li::before{background:transparent;border:1px solid var(--q-muted)}
.q-terms-list .q-line-desc{margin-top:2px}

/* ---- option matrix ---- */
.q-options{margin:20px 0 6px}
.q-options-intro{margin-bottom:16px}
.q-matrix{width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed}
.q-matrix th{vertical-align:bottom;text-align:left;padding:0 10px 14px;font-weight:400}
.q-matrix th:first-child{padding-left:0}
.q-matrix td{padding:11px 10px;border-bottom:1px solid var(--q-rule);font-size:14px;vertical-align:top;line-height:1.45}
.q-matrix td:first-child{color:var(--q-muted);padding-left:0;font-size:13.5px}
.q-matrix td.is-selected{background:var(--q-accent-soft)}
.q-matrix tr:last-child td{border-bottom:1px solid var(--q-rule-strong)}
.q-opt{display:block;border:1px solid var(--q-rule);background:var(--q-surface);padding:16px 16px 14px;position:relative;cursor:pointer;min-height:100%}
.q-opt:hover{border-color:var(--q-muted)}
.q-opt.is-selected{border-color:var(--q-ink);box-shadow:inset 0 0 0 1px var(--q-ink)}
/* These three are <span>s inside the option label. They MUST be block: inline
   spans ignore margin-top and run together on one line, which is how the
   package headline shipped as "Keep it running$600PER MONTH". */
.q-opt-name{display:block;font-family:var(--q-font-display);font-size:23px;line-height:1.1;text-wrap:balance}
.q-opt-price{display:block;font-family:var(--q-font-display);font-size:32px;line-height:1;margin-top:12px;font-variant-numeric:tabular-nums;letter-spacing:-0.01em}
.q-opt-per{display:block;font-family:var(--q-font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--q-muted);margin-top:6px}
.q-opt-per .q-pill{margin-left:8px;vertical-align:baseline}
.q-opt-ctl{display:flex;align-items:center;gap:9px;margin-top:14px;font-size:13.5px;color:var(--q-ink)}
.q-opt-ctl input{width:17px;height:17px;margin:0;accent-color:var(--q-accent);flex:none}
.q-opt-tag{position:absolute;top:-1px;right:-1px;background:var(--q-ink);color:var(--q-paper);font-family:var(--q-font-mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:5px 9px 4px;display:none}
.q-opt.is-selected .q-opt-tag{display:block}
.q-opt-alt{display:flex;flex-wrap:wrap;gap:10px 22px;align-items:center;border:1px solid var(--q-rule);border-top:0;padding:14px 16px;background:var(--q-surface);cursor:pointer}
.q-opt-alt.is-selected{border-color:var(--q-ink);box-shadow:inset 0 0 0 1px var(--q-ink);border-top:1px solid var(--q-ink)}
.q-opt-alt .q-opt-ctl{margin:0}
.q-opt-alt .q-opt-alt-name{font-weight:500}
.q-opt-alt .q-opt-alt-desc{flex:1 1 320px;color:var(--q-muted);font-size:13.5px;line-height:1.45}
.q-opt-alt .q-opt-alt-price{font-family:var(--q-font-display);font-size:24px;white-space:nowrap}
.q-opt-alt .q-opt-alt-price small{font-family:var(--q-font-mono);font-size:11px;letter-spacing:.08em;color:var(--q-muted)}
.q-opt-cards{display:none;gap:12px}
.q-opt-card{border:1px solid var(--q-rule);background:var(--q-surface);padding:16px;position:relative}
.q-opt-card.is-selected{border-color:var(--q-ink);box-shadow:inset 0 0 0 1px var(--q-ink)}
.q-opt-card .q-opt-tag{display:none}
.q-opt-card.is-selected .q-opt-tag{display:block}
.q-opt-card .q-opt-name,.q-opt-card .q-opt-price,.q-opt-card .q-opt-per{display:block}
.q-opt-card dl{margin:14px 0 0;display:grid;grid-template-columns:minmax(0,1fr);gap:0}
.q-opt-card dt{font-family:var(--q-font-mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--q-muted);margin-top:9px}
.q-opt-card dd{margin:2px 0 0;font-size:14px;line-height:1.45}
.q-opt-card .q-opt-ctl{margin-top:14px}
.q-select-note{font-size:13px;color:var(--q-muted);margin-top:10px}

/* ---- acceptance ---- */
.q-accept{margin-top:52px;border-top:1px solid var(--q-rule-strong);padding-top:30px;display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,400px);gap:30px 56px;align-items:start;scroll-margin-top:24px}
.q-accept-summary{list-style:none;margin:16px 0 0;padding:0;border-top:1px solid var(--q-rule)}
.q-accept-summary li{display:flex;justify-content:space-between;gap:18px;padding:10px 0;border-bottom:1px solid var(--q-rule);font-size:14.5px}
.q-accept-summary li span:last-child{font-family:var(--q-font-mono);font-size:13.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.q-accept-summary li.q-total{font-weight:600;border-bottom:1px solid var(--q-rule-strong)}
.q-accept-summary li.q-total span:last-child{font-size:15px}
.q-accept-summary .q-sub{color:var(--q-muted);font-size:13px;display:block;font-weight:400}
.q-tax{font-size:13px;color:var(--q-muted);margin-top:12px}
.q-form{border:1px solid var(--q-rule-strong);padding:24px 24px 22px;background:var(--q-surface)}
.q-form fieldset{border:0;padding:0;margin:0;min-width:0}
.q-form fieldset:disabled{opacity:.55}
.q-form-title{font-family:var(--q-font-display);font-size:26px;line-height:1.1;margin-bottom:6px}
.q-form-sub{font-size:13.5px;color:var(--q-muted);margin-bottom:18px;line-height:1.45}
.q-field{display:grid;gap:6px;margin-bottom:14px}
.q-field input[type=text],.q-field input[type=email]{font:inherit;font-size:16px;padding:10px 12px;border:1px solid var(--q-rule);border-bottom:1px solid var(--q-ink);background:var(--q-paper);color:var(--q-ink);border-radius:2px;width:100%;min-height:44px}
.q-field input::placeholder{color:var(--q-muted)}
.q-check{display:flex;gap:11px;align-items:flex-start;font-size:14.5px;line-height:1.45;margin:6px 0 18px}
.q-check input{width:18px;height:18px;margin:2px 0 0;accent-color:var(--q-accent);flex:none}
.q-btn{font:inherit;font-family:var(--q-font-body);font-weight:600;font-size:15px;letter-spacing:.01em;background:var(--q-ink);color:var(--q-paper);border:1px solid var(--q-ink);padding:13px 22px;border-radius:2px;cursor:pointer;min-height:48px;display:inline-flex;align-items:center;justify-content:center;gap:10px;text-decoration:none;width:100%}
.q-btn:hover{background:var(--q-accent-ink);border-color:var(--q-accent-ink)}
.q-btn:disabled{opacity:.5;cursor:default}
.q-btn.is-secondary{background:transparent;color:var(--q-ink);border-color:var(--q-ink);width:auto;min-height:42px;padding:9px 16px;font-size:14px}
.q-btn.is-secondary:hover{background:var(--q-accent-soft)}
.q-btn-row{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;margin-top:8px}
.q-form-err{color:var(--q-danger);font-size:14px;margin:0 0 12px;min-height:0}
.q-form-err:empty{display:none}
.q-noscript{font-size:13.5px;color:var(--q-muted);margin-top:12px}
.q-code-input{font-family:var(--q-font-mono);font-size:30px;letter-spacing:.35em;text-align:center;padding:12px 8px 12px 20px;border:1px solid var(--q-rule);border-bottom:2px solid var(--q-ink);background:var(--q-paper);color:var(--q-ink);border-radius:2px;width:100%;max-width:280px;min-height:60px}
.q-sig{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:26px;margin-top:26px}
.q-sig-line{border-bottom:1px solid var(--q-ink);height:52px;position:relative;display:flex;align-items:flex-end;padding-bottom:4px}
.q-sig-line .q-sig-name{font-family:var(--q-font-display);font-style:italic;font-size:30px;line-height:1;color:var(--q-ink)}
.q-sig .q-label{margin-top:8px;display:block}
.q-sig-print{display:none}
.q-receipt{border:1px solid var(--q-ink);padding:24px 26px 22px;background:var(--q-surface);position:relative;overflow:hidden}
.q-receipt .q-stamp{position:absolute;top:18px;right:18px}
.q-receipt-title{font-family:var(--q-font-display);font-size:28px;line-height:1.1;margin-bottom:8px;padding-right:150px}
.q-receipt-meta{font-size:14px;color:var(--q-muted);line-height:1.5;margin-bottom:14px}
.q-receipt ol{padding-left:20px;margin:8px 0 18px}
.q-receipt ol li{margin-bottom:8px;font-size:14.5px;line-height:1.5}
.q-receipt ol li::marker{font-family:var(--q-font-mono);font-size:12px;color:var(--q-accent-ink)}
.q-receipt-by{margin:6px 0 18px}

/* ---- studio band (preview only) ---- */
.q-studio-ribbon{position:sticky;top:0;z-index:30;background:var(--q-proposed);color:#fff;font-family:var(--q-font-mono);font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;padding:8px 16px;text-align:center}
.q-band{background:var(--q-band);color:var(--q-band-text);padding:28px clamp(18px,3vw,32px);margin-top:56px;border-top:6px solid var(--q-proposed)}
.q-band .q-label{color:var(--q-proposed)}
.q-band .q-h2{color:var(--q-band-text);margin:8px 0 16px}
.q-band .q-h3{color:var(--q-band-text)}
.q-band p,.q-band li,.q-band td{color:var(--q-band-text)}
.q-band .q-band-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:22px 40px}
.q-band .q-kv{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 16px;font-size:14px}
.q-band .q-kv dt{color:var(--q-proposed);font-family:var(--q-font-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;padding-top:3px}
.q-band .q-kv dd{margin:0}
.q-band table{width:100%;border-collapse:collapse;font-size:14px}
.q-band th{text-align:left;font-family:var(--q-font-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--q-proposed);font-weight:500;padding:0 12px 8px 0;border-bottom:1px solid var(--q-band-text)}
.q-band td{padding:9px 12px 9px 0;border-bottom:1px solid rgba(255,255,255,.14);vertical-align:top}
.q-band td.q-amt{text-align:right;white-space:nowrap;font-family:var(--q-font-mono);font-size:13.5px}

/* ---- footer ---- */
.q-footer{margin-top:60px;padding-top:14px;border-top:1px solid var(--q-rule);color:var(--q-muted);font-size:13px;display:flex;flex-wrap:wrap;gap:8px 28px;justify-content:space-between;line-height:1.5}

/* ---- sticky mobile call-to-action ---- */
.q-sticky{position:fixed;left:0;right:0;bottom:0;display:none;align-items:center;gap:14px;padding:11px 16px calc(11px + env(safe-area-inset-bottom));background:var(--q-ink);color:var(--q-paper);z-index:20;box-shadow:0 -10px 28px rgba(0,0,0,.22)}
.q-sticky-main{min-width:0;flex:1}
.q-sticky-sel{font-family:var(--q-font-mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.q-sticky-total{font-family:var(--q-font-display);font-size:22px;line-height:1.1;margin-top:2px;white-space:nowrap;font-variant-numeric:tabular-nums}
.q-sticky-total small{font-family:var(--q-font-mono);font-size:11px;letter-spacing:.06em;opacity:.72}
.q-sticky .q-btn{background:var(--q-paper);color:var(--q-ink);border-color:var(--q-paper);width:auto;min-height:44px;padding:10px 18px;flex:none}
.q-sticky .q-btn:hover{background:var(--q-surface)}

/* ---- responsive ----
   SCREEN only. A printed page is ~624 CSS px wide, so unqualified max-width
   rules would silently apply to the PDF and collapse the letterhead, the
   masthead and the section rails into their phone layouts. Paper gets its own
   block at the end of the file and nothing else. */
@media screen and (max-width:920px){
  .q-doc.has-studio .q-section{grid-template-columns:64px minmax(0,1fr)}
  .q-doc.has-studio .q-aside{grid-column:2;margin-top:14px}
  .q-accept{grid-template-columns:minmax(0,1fr)}
  .q-ledger{grid-template-columns:repeat(2,minmax(0,1fr))}
  .q-ledger>div:nth-child(3){border-left:0;padding-left:0}
  .q-ledger>div{border-top:1px solid var(--q-rule)}
  .q-ledger>div:nth-child(-n+2){border-top:0}
}
@media screen and (max-width:720px){
  .q-body{font-size:15.5px}
  .q-page{padding-bottom:132px}
  /* No spacer push at phone width — the toolbar wraps as one group instead of
     stranding the last link on a line of its own. */
  .q-toolbar{gap:10px 16px;justify-content:flex-start}
  .q-toolbar-sep{display:none}
  .q-theme{margin-right:0}
  .q-letterhead{grid-template-columns:minmax(0,1fr)}
  .q-meta{justify-content:start}
  .q-meta dt,.q-meta dd{text-align:left}
  .q-folio{text-align:left}
  .q-masthead{grid-template-columns:minmax(0,1fr);padding-top:30px}
  .q-masthead-side{justify-items:start}
  .q-prepared{text-align:left}
  .q-section{grid-template-columns:minmax(0,1fr);gap:6px 0;padding-top:30px}
  .q-section-no{font-size:34px}
  .q-matrix{display:none}
  .q-opt-cards{display:grid}
  .q-sticky{display:flex}
  .q-doc.no-cta .q-sticky{display:none}
  .q-sig{grid-template-columns:minmax(0,1fr)}
  .q-lines td.q-dim,.q-lines th.q-dim{display:none}
  /* A two-column markdown table in 358px squeezes its first column to one word
     per line. Stack the rows instead: the label reads as a line, its value as a
     muted line beneath it. The header is redundant once stacked. */
  .q-md-table,.q-md-table tbody,.q-md-table tr,.q-md-table td{display:block;width:auto}
  .q-md-table thead{display:none}
  .q-md-table tr{border-bottom:1px solid var(--q-rule);padding:10px 0}
  .q-md-table tr:last-child{border-bottom:0}
  .q-md-table td{border:0;padding:0}
  .q-md-table .q-md-last{white-space:normal;width:auto;margin-top:3px;font-size:13.5px;color:var(--q-muted)}
}
@media (prefers-reduced-motion:no-preference){
  .q-opt,.q-opt-alt,.q-opt-card,.q-btn{transition:border-color 140ms ease,background-color 140ms ease,box-shadow 140ms ease}
  html{scroll-behavior:smooth}
}

/* ---- print ---- */
@media print{
  .q-body{background:#fff;font-size:10.5pt;line-height:1.45}
  .q-page{max-width:none;padding:0}
  .q-toolbar,.q-sticky,.q-form,.q-code,.q-btn,.q-no-print,.q-studio-ribbon,.q-band,.q-aside{display:none!important}
  .q-doc.has-studio .q-section{grid-template-columns:52px minmax(0,1fr)}
  .q-sig-print{display:grid}
  .q-h1{font-size:34pt}
  .q-h2{font-size:20pt}
  .q-fig{font-size:22pt}
  .q-section{padding:22pt 0 16pt;grid-template-columns:52px minmax(0,1fr)}
  .q-section-no{font-size:30pt}
  .q-section-head,.q-h2,.q-h3,.q-h4,.q-options-intro{break-after:avoid;page-break-after:avoid}
  .q-letterhead,.q-masthead,.q-ledger{break-inside:avoid;page-break-inside:avoid}
  .q-masthead{padding:22pt 0 14pt}
  .q-ledger{margin-bottom:20pt}
  tr,.q-opt,.q-opt-alt,.q-receipt,.q-accept-summary li{break-inside:avoid;page-break-inside:avoid}
  tbody.q-keep{break-inside:avoid;page-break-inside:avoid}
  thead{display:table-header-group}
  .q-matrix{display:table}
  .q-opt-cards{display:none}
  .q-matrix td.is-selected{background:#eef1ee}
  .q-opt.is-selected,.q-opt-alt.is-selected{box-shadow:none;border:2px solid #000}
  .q-opt-ctl,.q-select-note{display:none}
  .q-opt-tag{display:none!important}
  .q-opt.is-selected .q-opt-tag,.q-opt-alt.is-selected .q-opt-tag{display:block!important}
  .q-accept{break-inside:avoid;page-break-inside:avoid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);margin-top:30pt;padding-top:18pt}
  .q-stamp{transform:rotate(-5deg)}
  .q-footer{margin-top:24pt;font-size:9pt}
  a{color:inherit;text-decoration:none}
  .q-tablewrap{overflow:visible}
}
`;
