// The answer runtime of every page a chat hands the owner (report.mjs pages, LifeLines mockup choice pages).
// Markup: .ak-chat[data-chat] blocks hold .ak-q[data-q] questions; a question holds .ak-opt[data-v] options, or carries
// data-options="A|B|C" and gets plain ones. A question outside every .ak-chat belongs to body[data-chat], and its notes and
// copy button go to [data-ak-end] or the end of the page. Picks, comments, marked spots and notes autosave per page; the
// copied text starts with the chat name. A question with a before and an after shot shows them as one swipe frame.
// Keys: 1-9 pick an option of the question in view, arrows go to the next or previous one.
// Same file in LifeLines tools/design/mockup/kit/ask.js; keep both the same.
(() => {
  const D = document, B = D.body;
  const ru = !/^en/i.test(B.dataset.akLang || D.documentElement.lang || 'ru');
  const T = ru ? {
    c: 'Комментарий', cph: 'Что поправить, что добавить (необязательно)', notes: 'Общие заметки для этого чата', nph: 'Всё, что не про один вопрос',
    pnotes: 'Замечания к этой странице', copy: 'Скопировать ответы', copyTo: (c) => `Скопировать ответы для «${c}»`, done: 'Скопировано: вставь в чат', none: 'не отвечено',
    of: (a, b) => `Отвечено ${a} из ${b}`, saved: 'сохранено', unsaved: 'не сохраняется: скопируй ответы до закрытия', name: 'Скопировать название',
    named: 'Название скопировано', mk: (on) => `Рамки: ${on ? 'вкл' : 'выкл'}`, head: (c, p, a) => `Чат «${c}»${a ? ` (аккаунт ${a})` : ''}: мои ответы со страницы «${p}»`, acct: 'аккаунт',
    cm: 'комментарий', gn: 'Общие заметки', from: 'Страницу сделал чат', un: 'не доказано', all: 'Взять все рекомендованные', manual: 'Скопировать не вышло: выдели текст (Ctrl+A, Ctrl+C) и вставь в чат', close: 'Закрыть',
    pin: 'Отметить место на картинке', pinOn: 'Нажми на картинку: туда встанет точка', pinOff: 'Отмена', pinPh: 'Что здесь не так',
    pinLine: (i, cap, x, y, t) => `   точка ${i} на «${cap}» (${x} % слева, ${y} % сверху): ${t}`, pinItem: (i, cap) => `Точка ${i} на «${cap}»`, rm: (i) => `Убрать точку ${i}`,
    pg: 'Точки на картинках страницы', step: (n, N) => `Решение ${n} из ${N} · клавиши 1–9 выбирают, → следующее`, swipe: 'Шторка: двигай, чтобы сравнить', swipeCap: 'шторка', was: 'как было', will: 'как станет',
  } : {
    c: 'Comment', cph: 'What to fix or add (optional)', notes: 'General notes for this chat', nph: 'Anything not about one question',
    pnotes: 'Notes on this page', copy: 'Copy answers', copyTo: (c) => `Copy answers for "${c}"`, done: 'Copied: paste it into the chat', none: 'no answer',
    of: (a, b) => `Answered ${a} of ${b}`, saved: 'saved', unsaved: 'not saved: copy the answers before closing', name: 'Copy name',
    named: 'Name copied', mk: (on) => `Marks: ${on ? 'on' : 'off'}`, head: (c, p, a) => `Chat "${c}"${a ? ` (account ${a})` : ''}: my answers from the page "${p}"`, acct: 'account',
    cm: 'comment', gn: 'General notes', from: 'Page made by the chat', un: 'not proven', all: 'Take all recommended', manual: 'Copy failed: select the text (Ctrl+A, Ctrl+C) and paste it into the chat', close: 'Close',
    pin: 'Mark a spot on a picture', pinOn: 'Click a picture to drop a point', pinOff: 'Cancel', pinPh: 'What is wrong here',
    pinLine: (i, cap, x, y, t) => `   point ${i} on "${cap}" (${x} % from left, ${y} % from top): ${t}`, pinItem: (i, cap) => `Point ${i} on "${cap}"`, rm: (i) => `Remove point ${i}`,
    pg: 'Points on the page pictures', step: (n, N) => `Decision ${n} of ${N} · keys 1–9 pick, → next`, swipe: 'Swipe: drag to compare', swipeCap: 'swipe', was: 'before', will: 'after',
  };
  const el = (tag, cls, text) => { const e = D.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const KEY = `ak:${location.pathname}|${B.dataset.page || D.title}`;
  let st = {};
  try { st = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { st = {}; }
  st.p ??= {}; st.c ??= {}; st.n ??= {}; st.pins ??= {};
  const msg = el('span', 'ak-msg');
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); msg.dataset.s = T.saved; } catch { msg.dataset.s = T.unsaved; } count(); };

  const copyText = async (text, ok) => {
    try { await navigator.clipboard.writeText(text); return ok(); } catch { /* a file:// page may have no clipboard API */ }
    const a = el('textarea'); a.value = text; a.style.cssText = 'position:fixed;left:-99rem'; B.append(a); a.select();
    let done = false; try { done = D.execCommand('copy'); } catch { done = false; }
    a.remove();
    if (done) return ok();
    const box = el('div', 'ak-manual'), ta = el('textarea'), x = el('button', 'ak-btn ak-sec', T.close);
    ta.value = text; ta.readOnly = true; x.type = 'button'; x.onclick = () => box.remove();
    box.append(el('b', '', T.manual), ta, x); B.append(box); ta.focus(); ta.select();
  };
  window.akCopy = copyText;
  const flash = (b, t) => { b.dataset.label ??= b.textContent; b.textContent = t; clearTimeout(b._t); b._t = setTimeout(() => { b.textContent = b.dataset.label; delete b.dataset.label; }, 2000); };
  // A hand-written page (a mockup) gets the chat bar from body[data-chat] and its unproven lines marked, as report.mjs does at build.
  if (B.dataset.chat && !D.querySelector('.ak-chatbar')) {
    const bar = el('div', 'ak-chatbar'), nb = el('button', 'ak-name', T.name);
    nb.type = 'button'; nb.dataset.akName = B.dataset.chat;
    bar.append(T.from, ' ', el('b', '', `«${B.dataset.chat}»`));
    if (B.dataset.account) { const ac = el('span', 'ak-acct', `${T.acct} `); ac.append(el('b', '', B.dataset.account)); bar.append(ac); }
    bar.append(nb);
    (D.querySelector('body > main') || B).prepend(bar);
  }
  D.querySelectorAll('.ak-proof li:not(.ak-un)').forEach((li) => { if (/не доказано|не проверено|не подтверждено|not proven|not checked|unverified/i.test(li.textContent)) { li.className = 'ak-un'; li.dataset.un = T.un; } });
  D.querySelectorAll('[data-ak-name]').forEach((b) => { b.onclick = () => copyText(b.dataset.akName, () => flash(b, T.named)); });

  // Chats: every .ak-chat, plus one tail block for questions that stand outside any (mockup pages), or for a page
  // without questions, so a remark or a marked spot can still be copied to the chat that made it.
  const qs = [...D.querySelectorAll('.ak-q')];
  // Picks are kept by number and question text, so a rebuilt page with other questions does not inherit old answers.
  qs.forEach((q, i) => { q.dataset.n ||= String(i + 1); q.dataset.k = `${q.dataset.n}|${q.dataset.q}`; });
  const chats = [...D.querySelectorAll('.ak-chat')];
  const main = D.querySelector('body > main') || B;
  if (qs.some((q) => !q.closest('.ak-chat')) || (!qs.length && B.dataset.chat)) {
    const tail = el('section', `ak-chat ak-tail${qs.length ? '' : ' ak-page'}`); tail.dataset.chat = B.dataset.chat || '';
    (D.querySelector('[data-ak-end]') || main).append(tail); chats.push(tail);
  }
  const chatOf = (q) => q.closest('.ak-chat') || chats[chats.length - 1];
  const name = (c) => c.dataset.chat || B.dataset.chat || '';
  const acctOf = (c) => c.dataset.account || (name(c) === B.dataset.chat ? B.dataset.account : '') || '';
  // Pictures outside the questions get a frame a point can sit in; their points go to the page's own chat.
  D.querySelectorAll('main figure > img').forEach((img) => { if (img.closest('.ak-q')) return; const f = el('span', 'ak-pf'); img.before(f); f.append(img); });
  const pageChat = chats.find((c) => name(c) === B.dataset.chat) || chats[0];

  // Swipe: question shots "before, after", or one shot of now plus a shot per option (the right side follows the pick).
  const capOf = (fig) => fig?.querySelector('figcaption')?.textContent.trim() || '';
  const layer = (fig, cls) => { const d = el('div', cls), f = fig.querySelector('.ak-frame').cloneNode(true); f.className = 'ak-sw-f'; d.append(f); return d; };
  const buildSwipe = (q, opts) => {
    const wrap = q.querySelector(':scope > .ak-shots');
    const ctx = wrap ? [...wrap.querySelectorAll('.ak-shot')].filter((f) => f.querySelector('.ak-frame')) : [];
    const shotOf = (o) => o && o.querySelector('.ak-shot');
    if (!ctx.length || (ctx.length < 2 && !opts.some(shotOf))) return;
    const box = el('div', 'ak-swipe'), range = el('input', 'ak-sw-range'), bar = el('div', 'ak-sw-bar');
    const tagA = el('span', 'ak-sw-tag ak-l'), tagB = el('span', 'ak-sw-tag ak-r');
    box.style.setProperty('--x', '50%');
    range.type = 'range'; range.min = '0'; range.max = '100'; range.value = '50'; range.setAttribute('aria-label', T.swipe);
    const setX = (x) => { box.style.setProperty('--x', `${x}%`); range.value = String(Math.round(x)); };
    range.oninput = () => setX(+range.value);
    let right = null;
    const show = () => {
      const k = q.dataset.k, picked = opts.find((o) => o.dataset.v === st.p[k]), rec = opts.find((o) => o.hasAttribute('data-rec'));
      // The right side names the option whose shot it shows: a picked option without a shot leaves the recommended one there.
      const srcOpt = ctx.length >= 2 ? null : [picked, rec, ...opts].find(shotOf);
      const src = srcOpt ? shotOf(srcOpt) : ctx[1];
      const lbl = srcOpt ? srcOpt.dataset.v : capOf(ctx[1]) || T.will;
      const nr = layer(src, 'ak-sw-b');
      if (right) right.replaceWith(nr); else box.prepend(nr);
      right = nr; tagB.textContent = `${lbl} →`; box.dataset.cap = `${T.swipeCap}: ${capOf(ctx[0]) || T.was} / ${lbl}`;
    };
    box.append(layer(ctx[0], 'ak-sw-a'), bar, tagA, tagB);
    tagA.textContent = `← ${capOf(ctx[0]) || T.was}`;
    show();
    box.addEventListener('pointerdown', (e) => {
      if (B.classList.contains('ak-pinning')) return;
      const move = (ev) => { const r = box.getBoundingClientRect(); setX(Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100))); };
      move(e); const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
    wrap.before(box, range); wrap.classList.add('ak-hide');
    return show;
  };

  // Marked spots: a point on a picture plus what is wrong there, kept per question (or per page) and copied as text.
  let pinning = null;
  const framesOf = (scope) => scope === 'page'
    ? [...D.querySelectorAll('.ak-pf')]
    : [...scope.querySelectorAll('.ak-frame, .ak-swipe')].filter((f) => !f.closest('.ak-hide'));
  const scopeKey = (scope) => (scope === 'page' ? 'page' : scope.dataset.k);
  const frameCap = (f) => f.dataset.cap || capOf(f.closest('figure')) || f.querySelector('img')?.alt || '?';
  const lists = new Map();
  const paintPins = () => {
    D.querySelectorAll('.ak-pin').forEach((p) => p.remove());
    for (const [scope, ol] of lists) {
      const k = scopeKey(scope), mine = st.pins[k] || [], frames = framesOf(scope);
      ol.textContent = '';
      mine.forEach((p, i) => {
        const f = frames[p.f];
        if (f) { const dot = el('span', 'ak-pin', String(i + 1)); dot.style.left = `${p.x}%`; dot.style.top = `${p.y}%`; f.append(dot); }
        const li = el('li'), x = el('button', 'ak-pin-x', '×'), ta = el('textarea');
        li.append(T.pinItem(i + 1, p.cap), ' ', x, ta);
        x.type = 'button'; x.setAttribute('aria-label', T.rm(i + 1)); x.onclick = () => { mine.splice(i, 1); if (!mine.length) delete st.pins[k]; paintPins(); save(); };
        ta.rows = 1; ta.placeholder = T.pinPh; ta.value = p.t || ''; ta.oninput = () => { p.t = ta.value; save(); };
        ol.append(li);
      });
    }
  };
  const pinButton = (scope, holder) => {
    if (!framesOf(scope).length) return;
    const b = el('button', 'ak-cbtn', T.pin), hint = el('span', 'ak-msg'), ol = el('ol', 'ak-pins');
    b.type = 'button';
    b.onclick = () => {
      const on = pinning !== scope;
      D.querySelectorAll('.ak-pinhint').forEach((h) => { h.textContent = ''; });
      D.querySelectorAll('.ak-pinon').forEach((x) => { x.classList.remove('ak-pinon'); x.textContent = T.pin; });
      pinning = on ? scope : null; B.classList.toggle('ak-pinning', on);
      if (on) { hint.textContent = T.pinOn; b.textContent = T.pinOff; b.classList.add('ak-pinon'); }
    };
    hint.classList.add('ak-pinhint');
    const row = el('div', 'ak-row'); row.append(b, hint);
    holder.append(row, ol); lists.set(scope, ol);
  };
  D.addEventListener('click', (e) => {
    if (!pinning) return;
    const f = e.target.closest('.ak-frame, .ak-swipe, .ak-pf');
    if (!f || !framesOf(pinning).includes(f)) return;
    // Immediate: the zoom listener on the same document must not open the picture under the new point.
    e.preventDefault(); e.stopImmediatePropagation();
    const r = f.getBoundingClientRect(), k = scopeKey(pinning);
    (st.pins[k] ??= []).push({ f: framesOf(pinning).indexOf(f), cap: frameCap(f), x: Math.round(((e.clientX - r.left) / r.width) * 100), y: Math.round(((e.clientY - r.top) / r.height) * 100), t: '' });
    const scope = pinning; pinning = null; B.classList.remove('ak-pinning');
    D.querySelectorAll('.ak-pinhint').forEach((h) => { h.textContent = ''; });
    D.querySelectorAll('.ak-pinon').forEach((x) => { x.classList.remove('ak-pinon'); x.textContent = T.pin; });
    paintPins(); save();
    [...lists.get(scope).querySelectorAll('textarea')].pop()?.focus();
  }, true);
  const pinLines = (k) => (st.pins[k] || []).map((p, i) => T.pinLine(i + 1, p.cap, p.x, p.y, (p.t || '').trim() || '—'));

  qs.forEach((q) => {
    const n = q.dataset.n, k = q.dataset.k;
    if (!q.querySelector('h3')) {
      const h = el('h3'); h.append(el('span', 'ak-n', n), el('span', '', q.dataset.q)); q.prepend(h);
    }
    if (qs.length > 1) q.querySelector('h3').before(el('div', 'ak-step', T.step(qs.indexOf(q) + 1, qs.length)));
    if (!q.querySelector('.ak-opt') && q.dataset.options) {
      const box = el('div', 'ak-opts');
      q.dataset.options.split('|').map((s) => s.trim()).filter(Boolean).forEach((v) => {
        const o = el('div', 'ak-opt'); o.dataset.v = v; o.append(el('div', 'ak-opt-h')); o.firstChild.append(el('b', '', v)); box.append(o);
      });
      q.append(box);
    }
    const opts = [...q.querySelectorAll('.ak-opt')];
    q._opts = opts;
    if (st.p[k] && !opts.some((o) => o.dataset.v === st.p[k])) delete st.p[k];
    const swipe = buildSwipe(q, opts);
    const paint = () => { opts.forEach((o) => o.setAttribute('aria-checked', String(st.p[k] === o.dataset.v))); q.classList.toggle('ak-done', !!st.p[k]); if (swipe) swipe(); };
    opts.forEach((o) => {
      o.setAttribute('role', 'radio'); o.tabIndex = 0;
      const pick = (e) => { if (e.target.closest('a,.ak-frame,textarea')) return; st.p[k] = st.p[k] === o.dataset.v ? '' : o.dataset.v; paint(); save(); };
      o.addEventListener('click', pick);
      o.addEventListener('keydown', (e) => { if (e.target === o && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(e); } });
    });
    q.querySelector('.ak-opts')?.setAttribute('role', 'radiogroup');
    q._paint = paint; paint();
    const cb = el('button', 'ak-cbtn', T.c), ta = el('textarea'); cb.type = 'button'; ta.rows = 2; ta.placeholder = T.cph; ta.value = st.c[k] || ''; ta.hidden = !ta.value;
    cb.onclick = () => { ta.hidden = false; ta.focus(); };
    ta.oninput = () => { st.c[k] = ta.value; save(); };
    const row = el('div', 'ak-row'); row.append(cb);
    q.append(row, ta);
    pinButton(q, q);
  });

  const textFor = (c) => {
    const mine = qs.filter((q) => chatOf(q) === c);
    const lines = [T.head(name(c), B.dataset.page || D.title, acctOf(c))];
    mine.forEach((q) => {
      const n = q.dataset.n, k = q.dataset.k;
      lines.push(`${n}. ${q.dataset.q} — ${st.p[k] || T.none}`);
      if ((st.c[k] || '').trim()) lines.push(`   ${T.cm}: ${st.c[k].trim()}`);
      lines.push(...pinLines(k));
    });
    if (c === pageChat && st.pins.page?.length) lines.push(`${T.pg}:`, ...pinLines('page'));
    const notes = (st.n[name(c)] || '').trim();
    if (notes) lines.push(`${T.gn}: ${notes}`);
    return lines.join('\n');
  };
  chats.forEach((c, i) => {
    const mine = qs.filter((q) => chatOf(q) === c);
    if (!mine.length && !c.classList.contains('ak-page')) return;
    const recs = mine.filter((q) => q.querySelector('.ak-opt[data-rec]'));
    const head = c.querySelector('.ak-chat-h');
    if (head && recs.length > 1) {
      const all = el('button', 'ak-btn ak-sec ak-all', T.all); all.type = 'button';
      all.onclick = () => { recs.forEach((q) => { if (!st.p[q.dataset.k]) st.p[q.dataset.k] = q.querySelector('.ak-opt[data-rec]').dataset.v; q._paint(); }); save(); };
      head.append(all);
    }
    const page = c.classList.contains('ak-page');
    const end = el('div', 'ak-end'), id = `ak-notes-${i}`, lab = el('label', '', page ? T.pnotes : T.notes), ta = el('textarea'), row = el('div', 'ak-row'), b = el('button', 'ak-btn', T.copy), m = el('span', 'ak-msg');
    lab.htmlFor = id; ta.id = id; ta.rows = 2; ta.placeholder = T.nph; ta.value = st.n[name(c)] || '';
    ta.oninput = () => { st.n[name(c)] = ta.value; save(); };
    b.type = 'button'; b.onclick = () => copyText(textFor(c), () => { m.textContent = T.done; });
    row.append(b, m); end.append(lab, ta);
    if (c === pageChat) pinButton('page', end);
    end.append(row); c.append(end);
  });
  paintPins();

  // Dock, fixed bottom-right: progress, the marks switch when a shot is marked, and the copy button of the chat in view.
  const live = chats.filter((c) => c.querySelector('.ak-end'));
  if (!live.length) return;
  const dock = el('div', 'ak-dock'), dcopy = el('button', 'ak-btn'); dcopy.type = 'button';
  dock.append(msg);
  if (D.querySelector('.ak-mk')) {
    const mk = el('button', 'ak-btn ak-sec'); mk.type = 'button';
    const set = (on) => { B.classList.toggle('ak-nomk', !on); mk.textContent = T.mk(on); };
    set(!st.nomk); mk.onclick = () => { st.nomk = !B.classList.contains('ak-nomk'); set(!st.nomk); save(); };
    dock.append(mk);
  }
  dock.append(dcopy); B.append(dock);
  let cur = live[0];
  const inView = () => { cur = live.filter((c) => c.getBoundingClientRect().top < innerHeight * 0.5).pop() || live[0]; const t = live.length > 1 ? T.copyTo(name(cur)) : T.copy; if (dcopy.dataset.label) dcopy.dataset.label = t; else dcopy.textContent = t; };
  dcopy.onclick = () => copyText(textFor(cur), () => flash(dcopy, T.done));
  function count() { msg.textContent = `${qs.length ? T.of(qs.filter((q) => st.p[q.dataset.k]).length, qs.length) : ''}${msg.dataset.s ? `${qs.length ? ' · ' : ''}${msg.dataset.s}` : ''}`; }
  let raf = 0; addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(inView); }, { passive: true });
  inView(); count();

  // One decision per screen: digits pick in the question in view, arrows move to the next or previous question.
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  D.addEventListener('keydown', (e) => {
    if (!qs.length || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('textarea,input,select,[contenteditable]')) return;
    const now = qs.filter((q) => q.getBoundingClientRect().top < innerHeight * 0.4).pop() || qs[0];
    if (/^[1-9]$/.test(e.key) && now._opts[e.key - 1]) { e.preventDefault(); now._opts[e.key - 1].click(); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const nx = qs[qs.indexOf(now) + (e.key === 'ArrowRight' ? 1 : -1)];
      if (nx) { e.preventDefault(); nx.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' }); }
    }
  });

  // A click on a shot opens it whole; a click or Escape closes it.
  D.addEventListener('click', (e) => {
    const f = e.target.closest('.ak-frame'); if (!f || pinning) return;
    e.stopPropagation(); const z = el('div', 'ak-zoom'), img = el('img'); img.src = f.querySelector('img').src; img.alt = f.querySelector('img').alt; z.append(img);
    z.onclick = () => z.remove(); B.append(z);
  }, true);
  D.addEventListener('keydown', (e) => { if (e.key === 'Escape') { D.querySelectorAll('.ak-zoom,.ak-manual').forEach((z) => z.remove()); if (pinning) D.querySelector('.ak-pinon')?.click(); } });
})();
