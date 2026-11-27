// The answer runtime of every page a chat hands the owner (report.mjs pages, LifeLines mockup choice pages).
// Markup: .ak-chat[data-chat] blocks hold .ak-q[data-q] questions; a question holds .ak-opt[data-v] options, or carries
// data-options="A|B|C" and gets plain ones. A question outside every .ak-chat belongs to body[data-chat], and its notes and
// copy button go to [data-ak-end] or the end of the page. Picks, comments and notes autosave per page; the copied text
// starts with the chat name. Same file in LifeLines tools/design/mockup/kit/ask.js; keep both the same.
(() => {
  const D = document, B = D.body;
  const ru = !/^en/i.test(B.dataset.akLang || D.documentElement.lang || 'ru');
  const T = ru ? {
    c: 'Комментарий', cph: 'Что поправить, что добавить (необязательно)', notes: 'Общие заметки для этого чата', nph: 'Всё, что не про один вопрос',
    copy: 'Скопировать ответы', copyTo: (c) => `Скопировать ответы для «${c}»`, done: 'Скопировано: вставь в чат', none: 'не отвечено',
    of: (a, b) => `Отвечено ${a} из ${b}`, saved: 'сохранено', unsaved: 'не сохраняется: скопируй ответы до закрытия', name: 'Скопировать название',
    named: 'Название скопировано', mk: (on) => `Рамки: ${on ? 'вкл' : 'выкл'}`, head: (c, p, a) => `Чат «${c}»${a ? ` (аккаунт ${a})` : ""}: мои ответы со страницы «${p}»`, acct: "аккаунт",
    cm: 'комментарий', gn: 'Общие заметки', from: 'Страницу сделал чат', un: 'не доказано', all: 'Взять все рекомендованные', manual: 'Скопировать не вышло: выдели текст (Ctrl+A, Ctrl+C) и вставь в чат', close: 'Закрыть',
  } : {
    c: 'Comment', cph: 'What to fix or add (optional)', notes: 'General notes for this chat', nph: 'Anything not about one question',
    copy: 'Copy answers', copyTo: (c) => `Copy answers for "${c}"`, done: 'Copied: paste it into the chat', none: 'no answer',
    of: (a, b) => `Answered ${a} of ${b}`, saved: 'saved', unsaved: 'not saved: copy the answers before closing', name: 'Copy name',
    named: 'Name copied', mk: (on) => `Marks: ${on ? 'on' : 'off'}`, head: (c, p, a) => `Chat "${c}"${a ? ` (account ${a})` : ""}: my answers from the page "${p}"`, acct: "account",
    cm: 'comment', gn: 'General notes', from: 'Page made by the chat', un: 'not proven', all: 'Take all recommended', manual: 'Copy failed: select the text (Ctrl+A, Ctrl+C) and paste it into the chat', close: 'Close',
  };
  const el = (tag, cls, text) => { const e = D.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const KEY = `ak:${location.pathname}|${B.dataset.page || D.title}`;
  let st = {};
  try { st = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { st = {}; }
  st.p ??= {}; st.c ??= {}; st.n ??= {};
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

  // Chats: every .ak-chat, plus one tail block for questions that stand outside any (mockup pages).
  const qs = [...D.querySelectorAll('.ak-q')];
  // Picks are kept by number and question text, so a rebuilt page with other questions does not inherit old answers.
  qs.forEach((q, i) => { q.dataset.n ||= String(i + 1); q.dataset.k = `${q.dataset.n}|${q.dataset.q}`; });
  const chats = [...D.querySelectorAll('.ak-chat')];
  if (qs.some((q) => !q.closest('.ak-chat'))) {
    const tail = el('section', 'ak-chat ak-tail'); tail.dataset.chat = B.dataset.chat || '';
    (D.querySelector('[data-ak-end]') || D.querySelector('body > main') || B).append(tail); chats.push(tail);
  }
  const chatOf = (q) => q.closest('.ak-chat') || chats[chats.length - 1];
  const name = (c) => c.dataset.chat || B.dataset.chat || '';
  const acctOf = (c) => c.dataset.account || (name(c) === B.dataset.chat ? B.dataset.account : '') || '';

  qs.forEach((q) => {
    const n = q.dataset.n, k = q.dataset.k;
    if (!q.querySelector('h3')) {
      const h = el('h3'); h.append(el('span', 'ak-n', n), el('span', '', q.dataset.q)); q.prepend(h);
    }
    if (!q.querySelector('.ak-opt') && q.dataset.options) {
      const box = el('div', 'ak-opts');
      q.dataset.options.split('|').map((s) => s.trim()).filter(Boolean).forEach((v) => {
        const o = el('div', 'ak-opt'); o.dataset.v = v; o.append(el('div', 'ak-opt-h')); o.firstChild.append(el('b', '', v)); box.append(o);
      });
      q.append(box);
    }
    const opts = [...q.querySelectorAll('.ak-opt')];
    if (st.p[k] && !opts.some((o) => o.dataset.v === st.p[k])) delete st.p[k];
    const paint = () => { opts.forEach((o) => o.setAttribute('aria-checked', String(st.p[k] === o.dataset.v))); q.classList.toggle('ak-done', !!st.p[k]); };
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
    q.append(cb, ta);
  });

  const textFor = (c) => {
    const mine = qs.filter((q) => chatOf(q) === c);
    const lines = [T.head(name(c), B.dataset.page || D.title, acctOf(c))];
    mine.forEach((q) => {
      const n = q.dataset.n, k = q.dataset.k;
      lines.push(`${n}. ${q.dataset.q} — ${st.p[k] || T.none}`);
      if ((st.c[k] || '').trim()) lines.push(`   ${T.cm}: ${st.c[k].trim()}`);
    });
    const notes = (st.n[name(c)] || '').trim();
    if (notes) lines.push(`${T.gn}: ${notes}`);
    return lines.join('\n');
  };
  chats.forEach((c, i) => {
    const mine = qs.filter((q) => chatOf(q) === c);
    if (!mine.length) return;
    const recs = mine.filter((q) => q.querySelector('.ak-opt[data-rec]'));
    const head = c.querySelector('.ak-chat-h');
    if (head && recs.length > 1) {
      const all = el('button', 'ak-btn ak-sec ak-all', T.all); all.type = 'button';
      all.onclick = () => { recs.forEach((q) => { if (!st.p[q.dataset.k]) st.p[q.dataset.k] = q.querySelector('.ak-opt[data-rec]').dataset.v; q._paint(); }); save(); };
      head.append(all);
    }
    const end = el('div', 'ak-end'), id = `ak-notes-${i}`, lab = el('label', '', T.notes), ta = el('textarea'), row = el('div', 'ak-row'), b = el('button', 'ak-btn', T.copy), m = el('span', 'ak-msg');
    lab.htmlFor = id; ta.id = id; ta.rows = 2; ta.placeholder = T.nph; ta.value = st.n[name(c)] || '';
    ta.oninput = () => { st.n[name(c)] = ta.value; save(); };
    b.type = 'button'; b.onclick = () => copyText(textFor(c), () => { m.textContent = T.done; });
    row.append(b, m); end.append(lab, ta, row); c.append(end);
  });

  // Dock, fixed bottom-right: progress, the marks switch when a shot is marked, and the copy button of the chat in view.
  if (!qs.length) return;
  const dock = el('div', 'ak-dock'), dcopy = el('button', 'ak-btn'); dcopy.type = 'button';
  dock.append(msg);
  if (D.querySelector('.ak-mk')) {
    const mk = el('button', 'ak-btn ak-sec'); mk.type = 'button';
    const set = (on) => { B.classList.toggle('ak-nomk', !on); mk.textContent = T.mk(on); };
    set(!st.nomk); mk.onclick = () => { st.nomk = !B.classList.contains('ak-nomk'); set(!st.nomk); save(); };
    dock.append(mk);
  }
  dock.append(dcopy); B.append(dock);
  const live = chats.filter((c) => qs.some((q) => chatOf(q) === c));
  let cur = live[0];
  const inView = () => { cur = live.filter((c) => c.getBoundingClientRect().top < innerHeight * 0.5).pop() || live[0]; const t = live.length > 1 ? T.copyTo(name(cur)) : T.copy; if (dcopy.dataset.label) dcopy.dataset.label = t; else dcopy.textContent = t; };
  dcopy.onclick = () => copyText(textFor(cur), () => flash(dcopy, T.done));
  function count() { msg.textContent = `${T.of(qs.filter((q) => st.p[q.dataset.k]).length, qs.length)}${msg.dataset.s ? ` · ${msg.dataset.s}` : ''}`; }
  let raf = 0; addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(inView); }, { passive: true });
  inView(); count();

  // A click on a shot opens it whole; a click or Escape closes it.
  D.addEventListener('click', (e) => {
    const f = e.target.closest('.ak-frame'); if (!f) return;
    e.stopPropagation(); const z = el('div', 'ak-zoom'), img = el('img'); img.src = f.querySelector('img').src; img.alt = f.querySelector('img').alt; z.append(img);
    z.onclick = () => z.remove(); B.append(z);
  }, true);
  D.addEventListener('keydown', (e) => { if (e.key === 'Escape') D.querySelectorAll('.ak-zoom,.ak-manual').forEach((z) => z.remove()); });
})();
