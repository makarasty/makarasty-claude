// Layout helpers and the render gate. `hyperframes check` samples a few frames and misses text that spills out of a
// fixed-width box (a node sized for Russian words, then English ones): layoutAudit throws, so check fails and names it.

// lay boxes out by their measured width instead of hand-picked lefts, so any language fits
window.flow = (els, x, gap = 20) => els.forEach((e) => { e.style.left = x + "px"; x += e.offsetWidth + gap; });
window.center = (els, cx, gap = 20) => window.flow(els, cx - (els.reduce((a, e) => a + e.offsetWidth, 0) + gap * (els.length - 1)) / 2, gap);
// shrink a one-line text to maxW; never grows it
window.fitText = (e, maxW) => { if (e.scrollWidth > maxW) e.style.fontSize = (parseFloat(getComputedStyle(e).fontSize) * maxW) / e.scrollWidth + "px"; };

// At each scene's last frame (before its exit at ends[i]): every text inside its box minus half the padding, every box
// inside its parent box, every free text inside the safe zone (x 132-876, y 288-1248, nowhere right of 780 below 840).
// boxes: the selector of every element that frames text; skip: containers whose text is a screenshot or texture.
window.layoutAudit = (tl, scenes, ends, boxes = ".node,.pill,.chip,.card", skip = ".win") => {
  const bad = [];
  scenes.forEach((s, i) => {
    tl.seek(ends[i] - 0.26);
    s.querySelectorAll(boxes).forEach((el) => {
      const p = el.parentElement.closest(boxes); if (!p || !s.contains(p)) return;
      const r = el.getBoundingClientRect(), b = p.getBoundingClientRect();
      if (r.left < b.left - 1 || r.right > b.right + 1) bad.push(`scene ${i + 1} "${el.textContent.trim()}" sticks out of "${p.textContent.trim().slice(0, 30)}"`);
    });
    s.querySelectorAll("*").forEach((el) => {
      const tn = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
      if (!tn.length || el.closest("svg")) return;
      const rg = document.createRange(); rg.setStartBefore(tn[0]); rg.setEndAfter(tn.at(-1));
      const r = rg.getBoundingClientRect(), say = (why) => bad.push(`scene ${i + 1} "${el.textContent.trim()}" ${why}`);
      if (!r.width) return;
      const box = el.closest(boxes);
      if (box) {
        const b = box.getBoundingClientRect(), cs = getComputedStyle(box), k = b.width / box.offsetWidth;
        const pl = (parseFloat(cs.paddingLeft) / 2 + parseFloat(cs.borderLeftWidth)) * k, pr = (parseFloat(cs.paddingRight) / 2 + parseFloat(cs.borderRightWidth)) * k;
        if (r.left < b.left + pl - 1 || r.right > b.right - pr + 1) say(`spills out of its box by ${Math.round(Math.max(b.left + pl - r.left, r.right - b.right + pr))}px`);
      }
      if (skip && el.closest(skip)) return;
      if (r.left < 130 || r.right > 878 || r.top < 286 || r.bottom > 1250) say(`leaves the safe zone (${Math.round(r.left)}..${Math.round(r.right)}, ${Math.round(r.top)}..${Math.round(r.bottom)})`);
      else if (r.bottom > 840 && r.right > 782) say(`runs under the platform buttons (right ${Math.round(r.right)})`);
    });
  });
  tl.seek(0);
  if (bad.length) { console.error(bad.join("\n")); throw new Error(`layout: ${bad.length} text overflow(s): ${bad.join("; ")}`); }
};
