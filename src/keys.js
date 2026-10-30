// キー表示ウインドウ。作業画面から送られてくる内容をそのまま並べる。
(function () {
  'use strict';
  const box = document.getElementById('keys');

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render(data) {
    box.replaceChildren();
    for (const sec of (data && data.sections) || []) {
      const g = el('div', 'group');
      g.append(el('p', 'group-title', sec.title));
      for (const it of sec.items) {
        const row = el('div', `item${it.team === 'A' ? ' a' : it.team === 'B' ? ' b' : ''}`);
        if (sec.title === 'ショートカット') row.append(el('span', 'team-line'));
        row.append(el('span', 'kbd', it.key), el('span', 'label', it.label));
        g.append(row);
      }
      box.append(g);
    }
    requestAnimationFrame(() => window.moment.resizeKeys(document.documentElement.scrollHeight));
  }

  window.moment.on('keys:data', render);
})();
