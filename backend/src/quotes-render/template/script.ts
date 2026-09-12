/**
 * The document's progressive-enhancement script (vanilla, no dependencies).
 * Without it the document is complete and readable; with it: option selection
 * updates the ledger strip, the acceptance summary and the sticky bar; the
 * acceptance form posts JSON (with an Idempotency-Key) and walks the client
 * through the code step; the confirmed page reloads into its receipt state.
 */

export const DOCUMENT_SCRIPT = `
(function(){
  var doc=document.querySelector('.q-doc');if(!doc)return;
  // Colour theme: auto follows the system, light/dark pin it. Per-reader only.
  var themeBtns=[].slice.call(document.querySelectorAll('[data-theme-set]'));
  if(themeBtns.length){
    var root=document.documentElement;
    function applyTheme(v){if(v==='light'||v==='dark'){root.setAttribute('data-theme',v)}else{root.removeAttribute('data-theme');v='auto'}themeBtns.forEach(function(b){b.setAttribute('aria-pressed',b.getAttribute('data-theme-set')===v?'true':'false')});try{localStorage.setItem('q-theme',v)}catch(e){}}
    themeBtns.forEach(function(b){b.addEventListener('click',function(){applyTheme(b.getAttribute('data-theme-set'))})});
    var saved=null;try{saved=localStorage.getItem('q-theme')}catch(e){}
    applyTheme(saved||(root.getAttribute('data-theme')||'auto'));
  }
  var cfg={};try{cfg=JSON.parse(doc.getAttribute('data-q')||'{}')}catch(e){}
  var base=cfg.base||{one_time:0,milestone:0,month:0,quarter:0,year:0,deposit:0};
  var sym=cfg.symbol||'$';
  function money(c){var neg=c<0;c=Math.abs(c);var w=Math.floor(c/100),f=c%100;var g=String(w).replace(/\\B(?=(\\d{3})+(?!\\d))/g,',');return (neg?'\\u2212':'')+sym+(f?g+'.'+String(f).padStart(2,'0'):g)}
  function suffix(i){return i==='month'?'/mo':i==='quarter'?'/qtr':i==='year'?'/yr':''}
  // A10 binding: the share page is server-rendered, so the browser asks for its
  // own cookie once, on load. The acceptance POSTs WAIT on this promise rather
  // than racing it, and re-bind once if the server still says 428 — a control
  // that fails intermittently is worse than no control.
  function bind(){if(!cfg.bind_url)return Promise.resolve();try{return fetch(cfg.bind_url,{credentials:'same-origin',cache:'no-store'}).then(function(){},function(){})}catch(e){return Promise.resolve()}}
  var bound=bind();
  var inputs=[].slice.call(document.querySelectorAll('input[data-opt]'));
  function selectedIds(){var ids={};inputs.forEach(function(i){if(i.checked)ids[i.value]=true});return Object.keys(ids)}
  function selectedOpts(){var seen={},out=[];inputs.forEach(function(i){if(i.checked&&!seen[i.value]){seen[i.value]=1;out.push({id:i.value,label:i.getAttribute('data-label')||'',amount:+i.getAttribute('data-amount')||0,deposit:+i.getAttribute('data-deposit')||0,kind:i.getAttribute('data-kind')||'one_time',interval:i.getAttribute('data-interval')||''})}});return out}
  // Every figure below is a SUM of numbers computeQuote already produced — the
  // line amounts and each line's own first payment part. The browser never
  // redoes a payment split, so "Due on acceptance" cannot drift from the server
  // by a rounding cent as the reader changes package.
  function totals(){var t={one_time:base.one_time,milestone:base.milestone,month:base.month,quarter:base.quarter,year:base.year,deposit:base.deposit||0};selectedOpts().forEach(function(o){if(o.kind==='recurring'){t[o.interval||'month']+=o.amount}else if(o.kind==='milestone'){t.milestone+=o.amount}else if(o.kind==='one_time'){t.one_time+=o.amount}t.deposit+=o.deposit});t.monthly=Math.round(t.month+t.quarter/3+t.year/12);t.year_one=t.one_time+t.milestone+t.month*12+t.quarter*4+t.year;return t}
  function setText(sel,txt){[].slice.call(document.querySelectorAll(sel)).forEach(function(el){el.textContent=txt})}
  function paint(){
    var ids=selectedIds();
    [].slice.call(document.querySelectorAll('[data-opt-id]')).forEach(function(el){var on=ids.indexOf(el.getAttribute('data-opt-id'))>=0;el.classList.toggle('is-selected',on);if(el.tagName==='LABEL'){el.setAttribute('aria-pressed',on?'true':'false')}});
    inputs.forEach(function(i){i.checked=ids.indexOf(i.value)>=0});
    var t=totals(),opts=selectedOpts();
    setText('[data-fig=one_time]',money(t.one_time));
    setText('[data-fig=milestone]',money(t.milestone));
    setText('[data-fig=monthly]',money(t.monthly));
    setText('[data-fig=year_one]',money(t.year_one));
    setText('[data-fig=deposit]',money(t.deposit));
    var names=opts.map(function(o){return o.label}).join(', ');
    setText('[data-fig-note=selection]',opts.length?('with '+names):cfg.no_selection_note||'no package selected');
    [].slice.call(document.querySelectorAll('[data-opt-summary]')).forEach(function(box){
      box.innerHTML='';opts.forEach(function(o){var li=document.createElement('li');var a=document.createElement('span');a.textContent=o.label;var b=document.createElement('span');b.textContent=money(o.amount)+suffix(o.interval);li.appendChild(a);li.appendChild(b);box.appendChild(li)});
    });
    setText('[data-fig=sticky-sel]',opts.length?names:(cfg.sticky_empty||'Choose a package'));
    [].slice.call(document.querySelectorAll('[data-opt-hidden]')).forEach(function(h){h.value=JSON.stringify(ids)});
  }
  inputs.forEach(function(i){i.addEventListener('change',paint)});
  paint();
  var cta=document.querySelector('[data-cta]');
  if(cta){cta.addEventListener('click',function(e){e.preventDefault();var f=document.querySelector('.q-accept');if(f){f.scrollIntoView({block:'start'});var n=document.getElementById('q-name');if(n)setTimeout(function(){n.focus({preventScroll:true})},350)}})}
  function uuid(){if(window.crypto&&crypto.randomUUID)return crypto.randomUUID();return 'k-'+Date.now()+'-'+Math.random().toString(16).slice(2)}
  function send(url,body,key){return fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json','Idempotency-Key':key},body:JSON.stringify(body)}).then(function(r){return r.text().then(function(t){var j=null;try{j=t?JSON.parse(t):null}catch(e){}return {status:r.status,body:j}})})}
  function post(url,body,key){return bound.then(function(){return send(url,body,key)}).then(function(res){
    // 428 means the binding never landed (a cold cache, a cleared cookie, a
    // reload from bfcache). Mint it and try once more before telling the client.
    if(res.status!==428)return res;
    bound=bind();return bound.then(function(){return send(url,body,key)});
  })}
  var form=document.getElementById('q-accept-form');
  var codeForm=document.getElementById('q-code-form');
  var err=document.getElementById('q-accept-err');
  var codeErr=document.getElementById('q-code-err');
  function say(el,msg){if(el){el.textContent=msg||''}}
  function explain(res,fallback){var b=res.body||{};var code=b.code||b.error||'';var map={QUOTE_SUPERSEDED:'This version of the quote was replaced. Ask for the current link.',QUOTE_EXPIRED:'This quote has expired. Ask for a fresh version.',QUOTE_REVOKED:'This link is no longer active.',NOT_A_RECIPIENT:'This quote was sent to named recipients. Use the address it was sent to.',COOKIE_REQUIRED:'Reload the page and try again.',CODE_INVALID:'That code is not right.',PENDING_VOIDED:'Too many wrong codes. Start the acceptance again.',PENDING_EXPIRED:'The code expired. Start the acceptance again.',PENDING_NOT_FOUND:'Start the acceptance again.'};return map[code]||b.detail||b.message||fallback}
  var pendingId=null,acceptKey=uuid(),confirmKey=uuid();
  if(form){form.addEventListener('submit',function(e){e.preventDefault();say(err,'');var fd=new FormData(form);var payload={name:String(fd.get('name')||'').trim(),email:String(fd.get('email')||'').trim(),title:String(fd.get('title')||'').trim(),accepted:!!fd.get('accepted'),selected_line_ids:selectedIds()};if(!payload.name||!payload.email||!payload.accepted){say(err,'Name, email and the acceptance checkbox are required.');return}var btn=form.querySelector('button[type=submit]');if(btn)btn.disabled=true;post(cfg.accept_url,payload,acceptKey).then(function(res){if(btn)btn.disabled=false;if(res.status===202||res.status===200){pendingId=res.body&&res.body.pending_id;confirmKey=uuid();form.hidden=true;var step=document.getElementById('q-code');if(step){step.hidden=false;var hint=document.getElementById('q-code-hint');if(hint&&res.body&&res.body.email_hint)hint.textContent=res.body.email_hint;var inp=document.getElementById('q-code-input');if(inp)inp.focus()}}else{say(err,explain(res,'Could not record the acceptance ('+res.status+').'))}}).catch(function(){if(btn)btn.disabled=false;say(err,'Network error. Check the connection and try again.')})})}
  if(codeForm){codeForm.addEventListener('submit',function(e){e.preventDefault();say(codeErr,'');var code=String(new FormData(codeForm).get('code')||'').replace(/\\D/g,'');if(code.length!==6){say(codeErr,'Enter the six digits from the email.');return}var btn=codeForm.querySelector('button[type=submit]');if(btn)btn.disabled=true;post(cfg.confirm_url,{pending_id:pendingId,code:code},confirmKey).then(function(res){if(res.status===200){var done=document.getElementById('q-code-done');if(done){codeForm.hidden=true;done.hidden=false}setTimeout(function(){location.reload()},650)}else{if(btn)btn.disabled=false;confirmKey=uuid();say(codeErr,explain(res,'That did not work ('+res.status+').'));if(res.body&&typeof res.body.attempts_left==='number'&&res.body.attempts_left>0){say(codeErr,explain(res,'')+' '+res.body.attempts_left+' attempt'+(res.body.attempts_left===1?'':'s')+' left.')}if(res.body&&(res.body.code==='PENDING_VOIDED'||res.body.code==='PENDING_EXPIRED'||res.body.code==='PENDING_NOT_FOUND')){var again=document.getElementById('q-code-again');if(again)again.hidden=false}}}).catch(function(){if(btn)btn.disabled=false;say(codeErr,'Network error. Try again.')})});var again=document.getElementById('q-code-again');if(again){again.addEventListener('click',function(){var step=document.getElementById('q-code');if(step)step.hidden=true;if(form){form.hidden=false;acceptKey=uuid();var n=document.getElementById('q-name');if(n)n.focus()}})}}
})();
`;
