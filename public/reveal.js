/* ══════════════════════════════════════════════════════════════════════════
   reveal.js — chuyển động cho dashboard Pancake
   1. Lướt tới đâu hiện tới đó: tiêu đề, thẻ số, biểu đồ, bảng hiện dần khi cuộn tới
      (thẻ hiện lần lượt, dòng bảng thả xuống, cột biểu đồ mọc lên, số chạy từ 0).
   2. Realtime (30s): số nào vừa đổi thì chạy từ số cũ sang số mới + loé vàng nhẹ;
      cột biểu đồ co/giãn mượt từ chiều cao cũ sang mới.
   3. Đổi khoảng ngày / sắp xếp bảng: phần số mờ nhẹ khi đang tải, rồi hiện lại lần lượt.

   CHỈ QUAN SÁT DOM (IntersectionObserver / MutationObserver). Không gọi, không sửa
   bất kỳ hàm dữ liệu nào. Khung cuối của mọi hiệu ứng số = ĐÚNG chuỗi app đã in ra
   (có hẹn giờ bảo hiểm trả về chuỗi gốc dù trình duyệt hoãn khung hình).
   Tắt hẳn khi máy bật "giảm chuyển động". Chế độ hình nền (?kiosk) không ẩn khối nào.
   ══════════════════════════════════════════════════════════════════════════ */
(() => {
  const html = document.documentElement;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window) || !('MutationObserver' in window)) return;

  const $ = (s) => document.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const ENTRY = !new URLSearchParams(location.search).has('kiosk');   // hình nền: luôn thấy số, không ẩn-rồi-hiện
  const now = () => performance.now();

  // Lỗi bất ngờ → trả trang về trạng thái thường (không bao giờ kẹt ẩn số)
  const bail = () => {
    html.classList.remove('rv-on');
    $$('.rv-wait').forEach((el) => el.classList.remove('rv-wait'));
    $$('tr.rv-hold').forEach((el) => el.classList.remove('rv-hold'));
  };
  const guard = (fn) => (...a) => { try { return fn(...a); } catch (e) { bail(); } };

  /* ── Hiệu ứng 1 phần tử: gắn class + độ trễ, tự gỡ khi xong ── */
  const anim = (el, cls, delay = 0, dur = 950) => {
    el.style.setProperty('--d', `${Math.round(delay)}ms`);
    el.classList.add(cls);
    setTimeout(() => { el.classList.remove(cls); el.style.removeProperty('--d'); }, delay + dur);
  };
  const tick = (el) => {                                   // ô số vừa đổi → loé vàng nhẹ
    el.classList.add('rv-tick');
    setTimeout(() => el.classList.remove('rv-tick'), 1700);
  };

  /* ── Số chạy — giữ nguyên định dạng app: 236.950.500đ · -350.000đ · 17.84% · 3,82 · 1.204 ── */
  const parse = (s) => {
    const toks = s.match(/-?\d[\d.,]*\d|-?\d/g);
    if (!toks || toks.length !== 1) return null;          // chỉ chạy chuỗi có đúng 1 con số (bỏ "1h 2m 3s", "—")
    const tok = toks[0], at = s.indexOf(tok);
    const neg = tok[0] === '-', b = neg ? tok.slice(1) : tok;
    let val, dec = 0, sep = '';
    if (/^\d{1,3}(\.\d{3})+$/.test(b)) val = +b.replace(/\./g, '');                        // 1.204 · 236.950.500
    else if (/^\d{1,3}(\.\d{3})*,\d+$/.test(b)) { sep = ','; dec = b.split(',')[1].length; val = +b.replace(/\./g, '').replace(',', '.'); } // 3,82
    else if (/^\d+\.\d+$/.test(b)) { sep = '.'; dec = b.split('.')[1].length; val = +b; }  // 17.84 (toFixed)
    else if (/^\d+$/.test(b)) val = +b;
    else return null;
    if (!isFinite(val)) return null;
    return { pre: s.slice(0, at), post: s.slice(at + tok.length), val: neg ? -val : val, dec, sep };
  };
  const VI = {};                                           // Intl vi-VN theo số chữ số thập phân (giống fmt() của app)
  const viFmt = (dec) => VI[dec] || (VI[dec] = new Intl.NumberFormat('vi-VN', { minimumFractionDigits: dec, maximumFractionDigits: dec }));
  const like = (v, p) => {
    const a = Math.abs(v);
    const neg = v < 0 && +a.toFixed(p.dec) !== 0;
    const body = p.sep === '.' ? a.toFixed(p.dec) : viFmt(p.dec).format(a);                 // "17.84" (toFixed) | "236.950.500" · "3,82"
    return p.pre + (neg ? '-' : '') + body + p.post;
  };
  const ease = (t) => 1 - Math.pow(1 - t, 4);

  // Chạy số trong NÚT CHỮ ĐẦU TIÊN của ô (vd "1.204" trong "1.204 / 388") — phần còn lại không đụng.
  const countUp = (el, from, delay = 0, dur = 1000) => {
    const node = el.firstChild;
    if (!node || node.nodeType !== 3 || document.hidden) return;
    const target = node.data, p = parse(target);
    if (!p || from === p.val || !isFinite(from)) return;
    if (el.__rvDone) el.__rvDone();
    let raf = 0, to = 0;
    const done = () => { cancelAnimationFrame(raf); clearTimeout(to); node.data = target; el.__rvDone = null; };
    const t0 = now() + delay;
    const step = (t) => {
      if (!el.isConnected) return done();
      const k = (t - t0) / dur;
      if (k >= 1) return done();
      node.data = like(from + (p.val - from) * ease(Math.max(0, k)), p);
      raf = requestAnimationFrame(step);
    };
    node.data = like(from, p);
    el.__rvDone = done;
    raf = requestAnimationFrame(step);
    to = setTimeout(done, delay + dur + 300);            // bảo hiểm: chắc chắn trả đúng chuỗi gốc
  };
  const countIn = (root, delay) => {
    const vals = root.matches('.val, .v') ? [root] : $$('.val, .v', root);
    vals.forEach((v) => countUp(v, 0, delay, 1100));
  };

  /* ── Dòng bảng: dòng đang thấy thả xuống lần lượt; dòng phía dưới chờ cuộn tới mới hiện ── */
  let rowBatch = 0, rowBatchT = 0;
  const rowIO = new IntersectionObserver(guard((es) => {
    es.forEach((e) => {
      if (!e.isIntersecting) return;
      const tr = e.target;
      rowIO.unobserve(tr);
      anim(tr, 'rv-row', Math.min(rowBatch++, 12) * 30, 700);
      tr.classList.remove('rv-hold');
    });
    clearTimeout(rowBatchT);
    rowBatchT = setTimeout(() => { rowBatch = 0; }, 140);
  }), { rootMargin: '0px 0px -4% 0px', threshold: 0 });

  const cascadeRows = (rows, base = 0) => {
    const vh = innerHeight;
    const tops = rows.map((tr) => tr.getBoundingClientRect().top);      // đọc hết rồi mới ghi (không giật layout)
    let i = 0;
    rows.forEach((tr, k) => {
      if (tops[k] < vh * 1.02) anim(tr, 'rv-row', base + Math.min(i++, 16) * 26, 700);
      else if (ENTRY) { tr.classList.add('rv-hold'); rowIO.observe(tr); }
    });
  };
  const rowsOf = (el) => $$(':scope tbody > tr, :scope tfoot > tr', el);

  /* ── Cột biểu đồ ── */
  const growBars = (bars, base = 0) => bars.forEach((b, i) => anim(b, 'rv-bar', base + 120 + i * 22, 1000));
  const flipBars = (olds, news) => {                     // realtime: co/giãn mượt từ chiều cao cũ sang mới
    if (!olds.length || olds.length !== news.length) return;
    const moved = [];
    news.forEach((b, i) => {
      const o = parseFloat(olds[i].style.height) || 0, n = parseFloat(b.style.height) || 0;
      if (n <= 0 || Math.abs(o - n) < 0.05) return;
      b.style.transformOrigin = '50% 100%';
      b.style.transform = `scaleY(${Math.min(60, o / n)})`;
      moved.push(b);
    });
    if (!moved.length) return;
    requestAnimationFrame(() => requestAnimationFrame(() => moved.forEach((b) => {
      b.style.transition = 'transform .85s var(--rv-ease), filter .15s var(--ease)';
      b.style.transform = '';
      setTimeout(() => { b.style.transition = ''; b.style.transformOrigin = ''; }, 900);
    })));
  };

  /* ── So số cũ ↔ mới theo "chỗ" (nhãn thẻ, tên dòng + cột) — không phụ thuộc thứ tự dòng ── */
  const norm = (s) => (s || '').replace(/[\d.,%()\s\-−]/g, '');
  const ctxOf = (el) => { const t = el.closest('.teamblock'); return t ? norm((t.querySelector('.tname') || {}).textContent) : ''; };
  const rowName = (tr) => {
    const td = tr.cells && tr.cells[0];
    if (!td || td.tagName !== 'TD') return '';
    const rk = td.querySelector('.rank');
    return td.textContent.slice(rk ? rk.textContent.length : 0).trim();
  };
  const slots = (roots) => {
    const m = new Map(), seen = {};
    const add = (k, el) => { const n = (seen[k] = (seen[k] || 0) + 1); m.set(n > 1 ? `${k}#${n}` : k, el); };
    roots.forEach((r) => {
      if (r.nodeType !== 1) return;
      (r.matches('.val, .v') ? [r] : $$('.val, .v', r)).forEach((v) => {
        const lab = v.previousElementSibling;
        add(`${ctxOf(v)}|v|${lab && lab.classList.contains('lab') ? norm(lab.textContent) : ''}`, v);
      });
      (r.matches('tr') ? [r] : $$('tr', r)).forEach((tr) => {
        const name = rowName(tr);
        if (name) [...tr.cells].forEach((td, i) => { if (i) add(`${ctxOf(tr)}|r|${name}|${i}`, td); });
      });
    });
    return m;
  };
  const diff = (olds, news, quiet) => {
    const om = slots(olds);
    if (!om.size) return;
    slots(news).forEach((el, k) => {
      const o = om.get(k);
      if (!o || o.textContent === el.textContent) return;
      if (el.matches('.val, .v') && o.firstChild && o.firstChild.nodeType === 3) {
        const p = parse(o.firstChild.data);
        if (p) countUp(el, p.val, 0, 850);
      }
      if (!quiet) tick(el);
    });
  };

  /* ── Người dùng vừa đổi ngày / sắp xếp → lần vẽ tới là "hiện lại", không loé từng ô ── */
  let replayUntil = 0, sortUntil = 0;
  const markReplay = () => { replayUntil = now() + 20000; };
  document.addEventListener('click', (e) => {
    if (e.target.closest('.dater .quick button')) markReplay();
    if (e.target.closest('thead th[data-k]')) sortUntil = now() + 1500;
  }, true);
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('thead th[data-k]')) sortUntil = now() + 1500;
  }, true);
  document.addEventListener('change', (e) => { if (e.target.matches && e.target.matches('#d-date, #d-date-to')) markReplay(); }, true);
  const replaying = () => {
    if (now() >= replayUntil) return false;
    replayUntil = Math.min(replayUntil, now() + 3000);     // cả lượt vẽ này (kể cả Kênh Live tải sau) cùng hiện lại
    return true;
  };

  // Đang tải khoảng ngày mới → mờ nhẹ phần số cũ (bỏ mờ ngay khi có số mới hoặc báo lỗi)
  const dash = $('#dash'), live = $('#live-txt');
  if (dash && live) {
    new MutationObserver(guard(() => {
      dash.classList.toggle('rv-busy', live.textContent === 'đang cập nhật…' && now() < replayUntil);
    })).observe(live, { childList: true, characterData: true, subtree: true });
  }

  /* ── Khối hiện khi lướt tới ── */
  const units = new Map();
  const io = new IntersectionObserver(guard((es) => {
    // Nhiều khối cùng lọt vào màn hình → hiện lần lượt từ trên xuống, trái sang phải
    es.map((e) => ({ e, r: e.boundingClientRect }))
      .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
      .reduce((base, { e, r }) => {
        const u = units.get(e.target);
        if (!u || u.shown) return base;
        u.inView = e.isIntersecting && r.height > 0;
        if (!u.inView || !ready(u)) return base;
        play(u, base);
        return base + 80;
      }, 0);
  }), { rootMargin: '0px 0px -7% 0px', threshold: 0 });

  const ready = (u) => u.kind !== 'grid' || !!u.el.querySelector(u.kids);
  const play = (u, base = 0) => {
    u.shown = true;
    io.unobserve(u.el);
    const el = u.el;
    if (u.kind === 'grid') {
      $$(u.kids, el).filter((k) => k.parentElement === el).forEach((k, i) => {
        anim(k, 'rv-kid', base + i * u.step);
        countIn(k, base + i * u.step + 140);
      });
    } else {
      anim(el, 'rv-self', base);
      if (u.kind === 'panel') { const rows = rowsOf(el); if (rows.length) cascadeRows(rows, base + 160); else u.rowsPending = true; }
      if (u.kind === 'chart') { const bars = $$('.bar', el); if (bars.length) growBars(bars, base); else u.barsPending = true; }
    }
    el.classList.remove('rv-wait');                       // cùng 1 khung với lúc gắn hiệu ứng → không nháy
  };
  const reobserve = (u) => { io.unobserve(u.el); io.observe(u.el); };   // observe lại = đo lại vị trí ngay

  // Bảo hiểm: khối nào đã có số, đang nằm trong màn hình mà vẫn ẩn → hiện luôn (không chờ hiệu ứng)
  const showNow = (u) => { u.shown = true; io.unobserve(u.el); u.el.classList.remove('rv-wait'); };
  const sweep = guard(() => {
    if (document.visibilityState !== 'visible') return;
    const vh = innerHeight;
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.bottom > 0 && r.top < vh; };
    // đọc hết vị trí trước, ghi sau (không giật layout)
    const us = [...units.values()].filter((u) => !u.shown && ready(u) && inView(u.el));
    const rows = $$('tr.rv-hold').filter(inView);
    us.forEach(showNow);
    rows.forEach((tr) => { rowIO.unobserve(tr); tr.classList.remove('rv-hold'); });
  });

  // Bàn phím: Tab vào ô đang chờ hiện (vd cột biểu đồ, tiêu đề bảng) → hiện ngay, không để focus vào chỗ vô hình
  document.addEventListener('focusin', guard((e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    units.forEach((u) => { if (!u.shown && u.el.contains(t)) showNow(u); });
    const tr = t.closest('tr.rv-hold');
    if (tr) { rowIO.unobserve(tr); tr.classList.remove('rv-hold'); }
  }));

  /* ── Theo dõi chỗ app vẽ số (app thay innerHTML mỗi lần cập nhật) ── */
  const onData = (box, owner) => guard((recs) => {
    const olds = [];
    let added = false;
    recs.forEach((r) => {
      r.removedNodes.forEach((n) => { if (n.nodeType === 1) olds.push(n); });
      r.addedNodes.forEach((n) => { if (n.nodeType === 1) added = true; });
    });
    if (!added) return;
    const u = owner && units.get(owner);
    if (u && !u.shown) { reobserve(u); setTimeout(sweep, 2600); return; }      // chưa lướt tới → giữ ẩn, chờ

    if (u && u.rowsPending && box.matches('tbody, tfoot')) { u.rowsPending = false; cascadeRows(rowsOf(owner), 60); return; }
    if (u && u.barsPending && box.id === 'pos-chart') { u.barsPending = false; growBars($$('.bar', box)); return; }
    if (!olds.length) return;                             // lần đầu có số → chưa có số cũ để so

    if (box.id === 'pos-chart') { flipBars(olds.filter((n) => n.classList.contains('bar')), $$('.bar', box)); return; }
    const sorted = box.id === 'tbody' && now() < sortUntil;
    const replay = !sorted && replaying();
    diff(olds, [...box.children], replay || sorted);
    if (!ENTRY || !(replay || sorted)) return;
    if (u && u.kind === 'grid') $$(u.kids, box).filter((k) => k.parentElement === box).forEach((k, i) => anim(k, 'rv-kid', i * u.step * 0.6));
    else if (box.matches('tbody')) cascadeRows([...box.children], 0);
  });

  try {
    if (ENTRY) {
      const reg = (sel, kind, kids, step) => $$(sel).forEach((el) => {
        if (units.has(el)) return;
        units.set(el, { el, kind, kids, step, shown: false, inView: false });
        el.classList.add('rv-wait');
      });
      reg('#dash > .topbar, #view-tabs, #dash .sec-title', 'self');
      reg('#pos-top, #kenhlive-cards, #cards', 'grid', '.c', 70);
      reg('#pos-kpi', 'grid', '.k', 40);
      reg('#teamgrid', 'grid', '.teamblock', 110);
      reg('#dash .chartwrap', 'chart');
      reg('#dash .panel', 'panel');
      units.forEach((u) => io.observe(u.el));
      document.addEventListener('visibilitychange', () => setTimeout(sweep, 2600));
      setInterval(sweep, 4000);
    }
    ['#pos-top', '#pos-kpi', '#pos-chart', '#pos-source', '#pos-product', '#pos-staff', '#teamgrid',
     '#kenhlive-cards', '#kenhlive-tbody', '#kenhlive-tfoot', '#cards', '#tbody'].forEach((sel) => {
      const box = $(sel);
      if (!box) return;
      const owner = units.has(box) ? box : box.closest('.chartwrap, .panel');
      new MutationObserver(onData(box, owner)).observe(box, { childList: true });
    });
    if (ENTRY) html.classList.add('rv-on');               // chỉ bật ẩn-chờ khi mọi thứ đã sẵn sàng
  } catch (e) { bail(); }
})();
