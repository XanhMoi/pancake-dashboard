// ─────────────────────────────────────────────────────────────────────────────
// Pancake Realtime Staff Dashboard
//
// Reproduces Pancake's OWN statistics numbers exactly by proxying the two
// endpoints that power Pancake's native dashboard:
//
//   1. POST https://pancake.vn/api/v1/statistics/customer_engagements
//        ?access_token=<chat>&date_range=DD/MM/YYYY HH:mm:ss - DD/MM/YYYY HH:mm:ss
//        body: multipart form-data  page_ids=<id,id,...>
//        → per-staff interactions, conversations, orders  (the "Theo nhân viên" table)
//
//   2. POST https://pos.pancake.vn/api/v1/shops/<shopId>/analytics/sale
//        ?access_token=<pos>
//        body: JSON { params:{ since, until, split_by, select_fields, filter } }
//        → POS order totals (new/old) — the source of truth for orders.
//
// SECURITY: tokens are entered ONLY in the browser setup screen and sent to this
// local proxy per-request. They are never logged and never leave this machine.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const CHAT_BASE = 'https://pancake.vn/api/v1';
const POS_BASE = 'https://pos.pancake.vn/api/v1';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// PHÂN QUYỀN — đăng nhập + tài khoản + cấu hình kết nối (token về server)
//
// • Tài khoản + quyền lưu ở DATA_DIR/users.json (gắn Railway Volume để bền qua deploy).
// • Token Pancake do ADMIN cấu hình 1 lần → DATA_DIR/config.json. User thường KHÔNG
//   nhập/không thấy token; server tự dùng token này để lấy số, rồi lọc theo quyền.
// • 4 mục phân quyền: chat · nhomSale · live · pos. Admin mặc định thấy hết.
// ─────────────────────────────────────────────────────────────────────────────
// Ưu tiên Railway Volume (tự set RAILWAY_VOLUME_MOUNT_PATH khi gắn volume) → khỏi set DATA_DIR tay
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOGINS_FILE = path.join(DATA_DIR, 'logins.json');
const SECRET = process.env.SESSION_SECRET || 'pancake-dash-doi-secret-nay-di';
const PERM_KEYS = ['chat', 'nhomSale', 'live', 'pos'];

function fullPerms() { return Object.fromEntries(PERM_KEYS.map(k => [k, true])); }
function cleanPerms(p) { return Object.fromEntries(PERM_KEYS.map(k => [k, !!(p || {})[k]])); }
function hashPw(pw, salt) { return crypto.pbkdf2Sync(String(pw), salt, 60000, 32, 'sha256').toString('hex'); }
function readJSON(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
function writeJSON(f, obj) { fs.writeFileSync(f, JSON.stringify(obj, null, 2)); }
function loadUsers() { return readJSON(USERS_FILE, { users: [] }); }
function saveUsers(u) { writeJSON(USERS_FILE, u); }
function findUser(u) { return (loadUsers().users || []).find(x => x.u.toLowerCase() === String(u || '').toLowerCase()); }
function permsOf(user) { return user.role === 'admin' ? fullPerms() : cleanPerms(user.perms); }
function recordLogin(u) {
  const log = readJSON(LOGINS_FILE, { logins: [] });
  log.logins.unshift({ u, at: new Date().toISOString() });
  log.logins = log.logins.slice(0, 100);   // giữ 100 lượt gần nhất
  writeJSON(LOGINS_FILE, log);
}

// Seed admin lần đầu (đổi mật khẩu qua env ADMIN_PASS trên Railway)
(function seedAdmin() {
  const d = loadUsers();
  if (!d.users || d.users.length === 0) {
    const salt = crypto.randomBytes(16).toString('hex');
    const u = process.env.ADMIN_USER || 'admin';
    const p = process.env.ADMIN_PASS || 'Xanh123@@';
    saveUsers({ users: [{ u, salt, pass: hashPw(p, salt), role: 'admin', perms: fullPerms(), created: new Date().toISOString() }] });
    console.log(`👤 Đã tạo admin đầu tiên: "${u}" (đổi mật khẩu qua env ADMIN_PASS)`);
  }
})();

// Cookie phiên: base64("user|sv").hmac  — ký bằng SECRET; sv = session version
function signSess(u, sv) { const b = Buffer.from(`${u}|${sv || 1}`).toString('base64'); return `${b}.${crypto.createHmac('sha256', SECRET).update(b).digest('hex')}`; }
function verifySess(tok) {
  if (!tok || !tok.includes('.')) return null;
  const [b, h] = tok.split('.');
  if (crypto.createHmac('sha256', SECRET).update(b).digest('hex') !== h) return null;
  try { const [u, sv] = Buffer.from(b, 'base64').toString('utf8').split('|'); return { u, sv: Number(sv) || 1 }; } catch { return null; }
}
function parseCookies(req) {
  const out = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function currentUser(req) {
  const s = verifySess(parseCookies(req).pd_sess);
  if (!s) return null;
  const user = findUser(s.u);
  if (!user) return null;                       // tài khoản bị xoá → phiên vô hiệu ngay
  if ((user.sv || 1) !== s.sv) return null;     // đổi MK / "đăng xuất tất cả" → phiên cũ vô hiệu
  return user;
}
function setSessCookie(res, user) {
  // 400 ngày = trần tối đa trình duyệt cho phép. Được gia hạn mỗi request auth (rolling) → không hết hạn khi còn dùng.
  res.setHeader('Set-Cookie', `pd_sess=${signSess(user.u, user.sv || 1)}; HttpOnly; Path=/; Max-Age=${400 * 24 * 3600}; SameSite=Lax`);
}
function requireAuth(req, res, next) { const u = currentUser(req); if (!u) return res.status(401).json({ error: 'Chưa đăng nhập' }); req.user = u; setSessCookie(res, u); next(); }
function requireAdmin(req, res, next) { const u = currentUser(req); if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Chỉ admin' }); req.user = u; next(); }

// ─── Đăng nhập / phiên ───
app.post('/api/login', (req, res) => {
  const { u, p } = req.body || {};
  const d = loadUsers();
  const user = (d.users || []).find(x => x.u.toLowerCase() === String(u || '').toLowerCase());
  if (!user || hashPw(p, user.salt) !== user.pass) return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
  if (!user.sv) user.sv = 1;
  user.lastLogin = new Date().toISOString();   // ghi "online lần cuối"
  saveUsers(d);
  recordLogin(user.u);                          // ghi nhật ký login gần đây
  setSessCookie(res, user);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'pd_sess=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.json({ auth: false });
  setSessCookie(res, user);   // gia hạn cookie mỗi lần mở nền
  const cfg = readJSON(CONFIG_FILE, {});
  res.json({ auth: true, u: user.u, role: user.role, perms: permsOf(user),
    configured: !!(cfg.chatToken && (cfg.pageIds || []).length) });
});

// ─── Admin · quản lý tài khoản ───
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ users: (loadUsers().users || []).map(x => ({ u: x.u, role: x.role, perms: permsOf(x), created: x.created, lastLogin: x.lastLogin || null })) });
});
app.get('/api/admin/logins', requireAdmin, (req, res) => { res.json(readJSON(LOGINS_FILE, { logins: [] })); });
app.post('/api/admin/logout-all', requireAdmin, (req, res) => {
  const d = loadUsers();
  (d.users || []).forEach(x => { x.sv = (x.sv || 1) + 1; });   // đá mọi phiên
  saveUsers(d);
  setSessCookie(res, findUser(req.user.u));                    // cấp phiên mới cho chính admin để không tự đá mình
  res.json({ ok: true });
});
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { u, p, perms, role } = req.body || {};
  if (!u || !p) return res.status(400).json({ error: 'Thiếu tên đăng nhập hoặc mật khẩu' });
  const d = loadUsers();
  if ((d.users || []).some(x => x.u.toLowerCase() === String(u).toLowerCase())) return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại' });
  const salt = crypto.randomBytes(16).toString('hex');
  d.users.push({ u: String(u).trim(), salt, pass: hashPw(p, salt), role: role === 'admin' ? 'admin' : 'user', perms: cleanPerms(perms), created: new Date().toISOString() });
  saveUsers(d); res.json({ ok: true });
});
app.post('/api/admin/users/update', requireAdmin, (req, res) => {
  const { u, p, perms, role } = req.body || {};
  const d = loadUsers();
  const user = (d.users || []).find(x => x.u.toLowerCase() === String(u || '').toLowerCase());
  if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  if (perms) user.perms = cleanPerms(perms);
  if (role) user.role = role === 'admin' ? 'admin' : 'user';
  if (p) { user.salt = crypto.randomBytes(16).toString('hex'); user.pass = hashPw(p, user.salt); user.sv = (user.sv || 1) + 1; }   // đổi MK → văng phiên cũ
  saveUsers(d);
  // nếu admin đổi MK của chính mình → cấp phiên mới để không tự đá mình
  if (p && req.user.u.toLowerCase() === user.u.toLowerCase()) setSessCookie(res, user);
  res.json({ ok: true });
});
app.post('/api/admin/users/delete', requireAdmin, (req, res) => {
  const { u } = req.body || {};
  const d = loadUsers();
  const t = (d.users || []).find(x => x.u.toLowerCase() === String(u || '').toLowerCase());
  if (!t) return res.status(404).json({ error: 'Không tìm thấy' });
  if (t.role === 'admin' && (d.users || []).filter(x => x.role === 'admin').length <= 1) return res.status(400).json({ error: 'Không thể xoá admin cuối cùng' });
  d.users = d.users.filter(x => x.u.toLowerCase() !== String(u).toLowerCase());
  saveUsers(d); res.json({ ok: true });
});

// ─── Admin · cấu hình kết nối Pancake (token lưu server, KHÔNG trả token về client) ───
app.get('/api/admin/config', requireAdmin, (req, res) => {
  const cfg = readJSON(CONFIG_FILE, {});
  res.json({ shopId: cfg.shopId || '', pageIds: cfg.pageIds || [], pages: cfg.pages || [], hasToken: !!cfg.chatToken });
});
app.post('/api/admin/config', requireAdmin, (req, res) => {
  const { chatToken, shopId, pageIds, pages } = req.body || {};
  const cfg = readJSON(CONFIG_FILE, {});
  if (chatToken) cfg.chatToken = chatToken;   // chỉ ghi đè khi có token mới
  if (shopId != null) cfg.shopId = shopId;
  if (pageIds != null) cfg.pageIds = pageIds;
  if (pages != null) cfg.pages = pages;
  writeJSON(CONFIG_FILE, cfg); res.json({ ok: true });
});

// ─── Date helpers (Vietnam UTC+7) ─────────────────────────────────────────────

// "2026-05-29" -> "2026-05-30"
function nextDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// "2026-05-29" -> "29/05/2026"
function ddmmyyyy(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

// date_range param for customer_engagements (from..to inclusive; to defaults to from)
function chatDateRange(from, to) {
  to = to || from;
  const a = ddmmyyyy(from);
  const b = ddmmyyyy(nextDay(to));
  return `${a} 00:00:00 - ${b} 00:00:00`;
}

// VN day range -> UTC ISO boundaries for POS analytics (VN 00:00 = UTC-7 of prev day 17:00)
function posBounds(from, to) {
  to = to || from;
  const since = new Date(from + 'T00:00:00+07:00').toISOString();
  const until = new Date(nextDay(to) + 'T00:00:00+07:00').toISOString();
  return { since, until };
}

// ─── Pancake Chat: customer_engagements (the native statistics) ────────────────
//
// IMPORTANT: this endpoint returns success=false (→ all zeros) if ANY page in the
// list is unsupported for messaging statistics (e.g. some Instagram/Shopee/Zalo
// pages, or pages not connected to chat). One bad page poisons the whole batch.
//
// Strategy: try the whole batch first (exact, single-snapshot match to Pancake).
// If it fails, query each page individually, drop the ones that fail, and merge
// the rest by user_id. Per-page sums reconstruct the same totals as the batch.

async function callEngApi(chatToken, pageIdsCsv, from, to) {
  const url = `${CHAT_BASE}/statistics/customer_engagements`
    + `?access_token=${encodeURIComponent(chatToken)}`
    + `&date_range=${encodeURIComponent(chatDateRange(from, to))}`;
  const fd = new FormData();
  fd.append('page_ids', pageIdsCsv);
  const res = await fetch(url, { method: 'POST', body: fd, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`customer_engagements HTTP ${res.status}`);
  return res.json();
}

const ENG_FIELDS = ['inbox_count', 'comment_count', 'total_engagement',
  'customer_engagement_new_inbox', 'new_customer_replied_count',
  'order_count', 'old_order_count'];

function mergeEngagements(jsons) {
  const userMap = new Map();
  for (const j of jsons) {
    for (const u of (j?.users_engagements || [])) {
      const prev = userMap.get(u.user_id) || { user_id: u.user_id, name: u.name };
      prev.name = prev.name || u.name;
      for (const f of ENG_FIELDS) prev[f] = (prev[f] || 0) + (u[f] || 0);
      userMap.set(u.user_id, prev);
    }
  }
  const users = [...userMap.values()];
  const series = ENG_FIELDS.map(f => ({
    name: f === 'inbox_count' ? 'inbox'
      : f === 'comment_count' ? 'comment'
      : f === 'total_engagement' ? 'total'
      : f === 'new_customer_replied_count' ? 'new_customer_replied'
      : f,
    data: [users.reduce((s, u) => s + (u[f] || 0), 0)],
  }));
  return { success: true, users_engagements: users, data: { series } };
}

async function fetchEngagements(chatToken, pageIds, from, to) {
  // 1) Try whole batch
  try {
    const batch = await callEngApi(chatToken, pageIds.join(','), from, to);
    if (batch && batch.success === true) {
      return { ...batch, okPages: pageIds.map(String), skipped: [] };
    }
  } catch (_) { /* fall through */ }

  // 2) Per-page fallback — keep only pages that succeed
  const settled = await Promise.allSettled(
    pageIds.map(id => callEngApi(chatToken, String(id), from, to))
  );
  const okJsons = [];
  const okPages = [];
  const skipped = [];
  settled.forEach((r, i) => {
    const id = String(pageIds[i]);
    if (r.status === 'fulfilled' && r.value && r.value.success === true) {
      okJsons.push(r.value);
      okPages.push(id);
    } else {
      skipped.push(id);
    }
  });

  const merged = mergeEngagements(okJsons);
  return { ...merged, okPages, skipped };
}

// ─── Pancake Chat: statistics/user (detailed per-staff activity) ───────────────
//
// Powers Pancake's "Thống kê chi tiết → Nhân viên" table. Same poison-page
// behaviour as customer_engagements → batch first, per-page fallback.
// data.users is keyed by user_id and ALREADY aggregated per staff.

const USER_SELECT = ['private_reply_count', 'comment_count', 'unique_comment_count',
  'inbox_count', 'unique_inbox_count', 'average_response_time',
  'phone_number_count', 'order_count'];
const USER_SUM_FIELDS = ['private_reply_count', 'comment_count', 'unique_comment_count',
  'inbox_count', 'unique_inbox_count', 'phone_number_count', 'order_count'];

// same-day range: "DD/MM/YYYY 00:00:00 - DD/MM/YYYY 23:59:59"
function userDateRange(from, to) {
  to = to || from;
  const a = ddmmyyyy(from);
  const b = ddmmyyyy(to);
  return `${a} 00:00:00 - ${b} 23:59:59`;
}

async function callUserApi(chatToken, pageIdsCsv, from, to) {
  const url = `${CHAT_BASE}/statistics/user`
    + `?date_range=${encodeURIComponent(userDateRange(from, to))}`
    + `&access_token=${encodeURIComponent(chatToken)}`
    + `&select_fields=${encodeURIComponent(JSON.stringify(USER_SELECT))}`;
  const fd = new FormData();
  fd.append('page_ids', pageIdsCsv);
  const res = await fetch(url, { method: 'POST', body: fd, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`statistics/user HTTP ${res.status}`);
  return res.json();
}

// Merge data.users maps across pages by user_id. Sums counts; response time is
// weighted by inbox_count (so combined average stays meaningful).
function mergeUserStats(jsons) {
  const map = new Map();
  for (const j of jsons) {
    const users = j?.data?.users;
    if (!users) continue;
    for (const uid of Object.keys(users)) {
      const u = users[uid];
      const prev = map.get(uid) || { user_id: uid, name: u.user_name || u.name || ('NV ' + uid.slice(0, 6)), _rtWeighted: 0, _rtWeight: 0 };
      prev.name = prev.name || u.user_name || u.name;
      for (const f of USER_SUM_FIELDS) prev[f] = (prev[f] || 0) + (u[f] || 0);
      const w = u.inbox_count || 0;
      prev._rtWeighted += (u.average_response_time || 0) * (w || 1);
      prev._rtWeight += (w || 1);
      map.set(uid, prev);
    }
  }
  const users = [...map.values()].map(u => {
    u.average_response_time = u._rtWeight ? Math.round(u._rtWeighted / u._rtWeight) : 0;
    delete u._rtWeighted; delete u._rtWeight;
    return u;
  });
  return users;
}

async function fetchUserStats(chatToken, pageIds, from, to) {
  // batch first
  try {
    const batch = await callUserApi(chatToken, pageIds.join(','), from, to);
    if (batch && batch.success === true && batch.data?.users) {
      return mergeUserStats([batch]);
    }
  } catch (_) { /* fall through */ }
  // per-page fallback
  const settled = await Promise.allSettled(pageIds.map(id => callUserApi(chatToken, String(id), from, to)));
  const ok = settled.filter(r => r.status === 'fulfilled' && r.value?.success === true).map(r => r.value);
  return mergeUserStats(ok);
}

// ─── Pancake POS: analytics/sale (order source of truth) ───────────────────────

async function fetchPosSale(posToken, shopId, pageIds, from, to) {
  const url = `${POS_BASE}/shops/${shopId}/analytics/sale`
    + `?access_token=${encodeURIComponent(posToken)}`;
  const { since, until } = posBounds(from, to);

  const body = {
    params: {
      success_status: '1',
      success_record: 'updated_at',
      returned_record: 'success_record',
      returned_status: '5',
      user_type: 'assign',
      since,
      until,
      split_by: ['User.id', 'Time.day'],
      select_fields: ['order_count', 'new_order_count', 'old_order_count'],
      filter: {
        'Order.source': pageIds.map(id => ({
          page_id: null,
          order_sources: '-1',
          account: String(id),
        })),
      },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`analytics/sale HTTP ${res.status}`);
  return res.json();
}

// ─── Pancake POS: overview (Tổng quan) — whole-shop totals like pos UI ──────────
// Mirrors pos.pancake.vn → Tổng quan. Uses the SAME analytics/sale endpoint but
// split_by Time.hour (→ returns `summary` totals + per-hour data for the chart)
// plus analytics/total_inventory for the "Có thể bán" card. No page filter:
// this is the whole-shop overview (a separate section from the per-staff table).

const POS_OV_FIELDS = ['order_count', 'total_order_count', 'canceled_order_count',
  'removed_order_count', 'product_count', 'customer_count', 'capital', 'price',
  'price_data', 'cod', 'prepaid', 'prepaid_by_point', 'shipping_fee', 'discount',
  'surcharge', 'partner_fee', 'ads_amount', 'fee_marketplace', 'affiliate_price',
  'marketplace_voucher', 'exchange_payment', 'diff_shipping_fee', 'part_returned_count'];

async function fetchPosOverview(posToken, shopId, from, to) {
  const { since, until } = posBounds(from, to);
  const base = { success_status: '1', success_record: 'updated_at',
    returned_record: 'success_record', returned_status: '5', user_type: 'assign' };

  const saleUrl = `${POS_BASE}/shops/${shopId}/analytics/sale?access_token=${encodeURIComponent(posToken)}`;
  const body = { params: { ...base, filter: {}, since, until,
    split_by: ['Time.hour'], select_fields: POS_OV_FIELDS } };
  const res = await fetch(saleUrl, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`POS overview HTTP ${res.status}`);
  const sale = await res.json();

  // Inventory ("Có thể bán") — snapshot, but pass same params to match POS UI.
  let inventory = null;
  try {
    const q = new URLSearchParams({ access_token: posToken, ...base,
      filter: '{}', since, until });
    const ir = await fetch(`${POS_BASE}/shops/${shopId}/analytics/total_inventory?${q}`,
      { signal: AbortSignal.timeout(15000) });
    if (ir.ok) { const ij = await ir.json(); inventory = ij.data || null; }
  } catch (_) { /* inventory optional */ }

  return { summary: sale.summary || null, data: sale.data || [], inventory };
}

// Derive the exact overview cards Pancake shows (formulas verified vs POS HAR).
function buildPosOverview(ov) {
  if (!ov || !ov.summary) return null;
  const s = ov.summary;
  const n = k => Number(s[k]) || 0;
  const price = n('price'), shipping = n('shipping_fee'), surcharge = n('surcharge');
  const discount = n('discount'), capital = n('capital'), partnerFee = n('partner_fee');
  const ads = n('ads_amount'), feeMkt = n('fee_marketplace'), affiliate = n('affiliate_price');
  const orderCount = n('order_count'), productCount = n('product_count');

  const doanhSo = price + shipping + surcharge;            // Doanh số
  const doanhThu = doanhSo - discount;                     // Doanh thu
  const loiNhuan = doanhThu - capital - partnerFee - ads - feeMkt - affiliate; // Lợi nhuận
  const loiNhuanPct = doanhThu > 0 ? (loiNhuan / doanhThu) * 100 : 0;
  const gttb = orderCount > 0 ? doanhThu / orderCount : 0;  // Giá trị TB / đơn
  const slsptb = orderCount > 0 ? productCount / orderCount : 0; // SL SP TB
  const lntb = orderCount > 0 ? loiNhuan / orderCount : 0;  // Lợi nhuận TB

  // Returns ("Tổng hàng hoàn") — summed from per-row `returned` blocks if present.
  let returnedAmount = 0, returnedQty = 0;
  for (const row of (ov.data || [])) {
    const r = row.returned;
    if (r && typeof r === 'object') {
      returnedAmount += Number(r.price) || 0;
      returnedQty += Number(r.product_count) || Number(r.order_count) || 0;
    }
  }

  // Hourly revenue chart (0..23) — revenue per hour using the same formula.
  const hourly = new Array(24).fill(0);
  for (const row of (ov.data || [])) {
    const hh = parseInt(row['Time.hour'], 10);
    const r = row.result || row.success || {};
    if (!isNaN(hh) && hh >= 0 && hh < 24) {
      hourly[hh] += (Number(r.price) || 0) + (Number(r.shipping_fee) || 0)
        + (Number(r.surcharge) || 0) - (Number(r.discount) || 0);
    }
  }

  return {
    closedAmount: price, closedQty: productCount,
    returnedAmount, returnedQty,
    doanhSo, doanhThu, loiNhuan, loiNhuanPct,
    orderCount, gttb, slsptb, lntb, capital,
    inventory: ov.inventory ? {
      quantity: Number(ov.inventory.total_remain_quantity) || 0,
      buyPrice: Number(ov.inventory.total_remain_amount) || 0,
      sellPrice: Number(ov.inventory.total_remain_price) || 0,
    } : null,
    hourly,
  };
}

// ─── POS breakdowns: Nguồn đơn / Sản phẩm / Nhân viên (with 7-day comparison) ───
// Same analytics/sale endpoint, different split_by, each with compare_ranges so we
// get the prior-period numbers for the ↑/↓ % arrows the POS UI shows.

const POS_BRK_FIELDS = ['order_count', 'total_order_count', 'product_count',
  'customer_count', 'group_customer_count', 'capital', 'price', 'price_data',
  'cod', 'prepaid', 'shipping_fee', 'discount', 'surcharge', 'partner_fee',
  'ads_amount', 'fee_marketplace', 'affiliate_price', 'part_returned_count',
  'removed_order_count'];

function shiftIso(iso, days) {
  return new Date(new Date(iso).getTime() - days * 86400000).toISOString();
}

async function callSaleSplit(posToken, shopId, since, until, splitBy) {
  const url = `${POS_BASE}/shops/${shopId}/analytics/sale?access_token=${encodeURIComponent(posToken)}`;
  const body = { params: {
    success_status: '1', success_record: 'updated_at',
    returned_record: 'success_record', returned_status: '5',
    user_type: 'assign', filter: {}, since, until,
    split_by: splitBy, select_fields: POS_BRK_FIELDS,
    compare_ranges: [
      { since, until },
      { since: shiftIso(since, 7), until: shiftIso(until, 7) },
    ],
  } };
  const res = await fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`sale ${splitBy} HTTP ${res.status}`);
  return res.json();
}

async function fetchPosBreakdowns(posToken, shopId, from, to) {
  const { since, until } = posBounds(from, to);
  const [staff, source, product] = await Promise.all([
    callSaleSplit(posToken, shopId, since, until, ['User.id']),
    callSaleSplit(posToken, shopId, since, until, ['Order.source']),
    callSaleSplit(posToken, shopId, since, until, ['Variation.product_id']),
  ]);
  return { staff, source, product };
}

function brkRowMetrics(r) {
  const n = k => Number(r[k]) || 0;
  const price = n('price'), shipping = n('shipping_fee'), sur = n('surcharge');
  const disc = n('discount'), cap = n('capital'), pf = n('partner_fee');
  const ads = n('ads_amount'), fm = n('fee_marketplace'), aff = n('affiliate_price');
  const oc = n('order_count'), pc = n('product_count'), toc = n('total_order_count');
  const doanhSo = price + shipping + sur;
  const doanhThu = doanhSo - disc;
  const loiNhuan = doanhThu - cap - pf - ads - fm - aff;
  return { doanhThu, doanhSo, loiNhuan, chietKhau: disc, donChot: oc,
    slBan: pc, totalOrder: toc, gttb: oc > 0 ? doanhThu / oc : 0,
    tyLeChot: toc > 0 ? (oc / toc) * 100 : 0 };
}

function processBreakdown(j, keyOf, metaOf) {
  const cur = (j?.data?.[0]?.data) || [];
  const prev = (j?.data?.[1]?.data) || [];
  const pmap = new Map();
  for (const r of prev) pmap.set(keyOf(r), brkRowMetrics(r.result || {}));
  return cur.map(r => {
    const m = brkRowMetrics(r.result || {});
    const pm = pmap.get(keyOf(r)) || {};
    const ret = r.returned || {};
    return { ...metaOf(r), ...m,
      returnedQty: Number(ret.product_count) || 0,
      prev: { doanhThu: pm.doanhThu || 0, doanhSo: pm.doanhSo || 0,
        loiNhuan: pm.loiNhuan || 0, donChot: pm.donChot || 0,
        slBan: pm.slBan || 0, chietKhau: pm.chietKhau || 0 } };
  });
}

function buildPosBreakdowns(raw) {
  if (!raw) return null;
  const staff = processBreakdown(raw.staff,
    r => r['User.id'],
    r => ({ key: r['User.id'], name: (r.user && r.user.name) || 'Không tên' }))
    .sort((a, b) => b.doanhThu - a.doanhThu);
  const product = processBreakdown(raw.product,
    r => r['Variation.product_id'],
    r => ({ key: r['Variation.product_id'],
      name: (r.product && r.product.name) || '—',
      code: (r.product && r.product.custom_id) || '' }))
    .sort((a, b) => b.doanhThu - a.doanhThu);
  const source = processBreakdown(raw.source,
    r => String(r.account),
    r => ({ key: r.account == null ? null : String(r.account) }))
    .sort((a, b) => b.doanhThu - a.doanhThu);
  return { staff, product, source };
}

// ─── Combine into the shape the dashboard renders ──────────────────────────────

function buildMetrics(engRes, posRes, userStats) {
  const users = Array.isArray(engRes?.users_engagements) ? engRes.users_engagements : [];
  const okPages = engRes?.okPages || [];
  const skipped = engRes?.skipped || [];

  // series → totals (matches Pancake's top cards)
  const series = {};
  for (const s of (engRes?.data?.series || [])) {
    series[s.name] = Array.isArray(s.data) ? (s.data[0] || 0) : 0;
  }

  // POS order map keyed by user_id (UUID) — source of truth for orders
  const posByUser = new Map();
  let posSummary = null;
  if (posRes && posRes.summary) {
    posSummary = posRes.summary;
    for (const row of (posRes.data || [])) {
      const uid = row['User.id'];
      const r = row.success || row.result || {};
      if (!uid) continue;
      const prev = posByUser.get(uid) || { order_count: 0, new_order_count: 0, old_order_count: 0 };
      prev.order_count += r.order_count || 0;
      prev.new_order_count += r.new_order_count || 0;
      prev.old_order_count += r.old_order_count || 0;
      posByUser.set(uid, prev);
    }
  }

  const staff = users.map(u => {
    const total = u.total_engagement || 0;
    const newCust = u.new_customer_replied_count || 0;
    const oldCust = total - newCust;                  // TT khách cũ
    // When POS is connected it is the SOURCE OF TRUTH for orders: staff with no
    // POS orders show 0 (matches Pancake's POS-sourced per-staff table). Only when
    // POS is NOT connected do we derive orders from chat engagement data.
    const pos = posByUser.get(u.user_id);
    let orders, newOrders, oldOrders;
    if (posSummary) {
      orders = pos ? pos.order_count : 0;
      newOrders = pos ? pos.new_order_count : 0;
      oldOrders = pos ? pos.old_order_count : 0;
    } else {
      orders = u.order_count || 0;
      oldOrders = u.old_order_count || 0;
      newOrders = Math.max(0, orders - oldOrders);
    }
    const convRate = total > 0 ? (orders / total) * 100 : 0;
    return {
      user_id: u.user_id,
      name: u.name || 'Không tên',
      total,                                          // Tổng TT
      newCust,                                        // TT khách mới
      oldCust,                                        // KH cũ
      inbox: u.inbox_count || 0,                      // Tin nhắn
      comment: u.comment_count || 0,                  // Bình luận
      newConv: u.customer_engagement_new_inbox || 0,  // Hội thoại mới
      orders,                                         // Đơn hàng đã chốt
      newOrders,
      oldOrders,
      convRate,                                       // Tỉ lệ chốt đơn
    };
  });

  staff.sort((a, b) => b.orders - a.orders || b.total - a.total);

  // Summary cards
  const totalInteractions = series.total || staff.reduce((s, x) => s + x.total, 0);
  const totalInbox = series.inbox || staff.reduce((s, x) => s + x.inbox, 0);
  const totalComment = series.comment || staff.reduce((s, x) => s + x.comment, 0);
  const newCustTotal = series.new_customer_replied || staff.reduce((s, x) => s + x.newCust, 0);
  const oldCustTotal = totalInteractions - newCustTotal;
  const newConvTotal = series.customer_engagement_new_inbox || staff.reduce((s, x) => s + x.newConv, 0);

  // Orders: POS summary is the source of truth; fall back to engagement series
  const orderTotal = posSummary ? posSummary.order_count : (series.order_count || 0);
  const oldOrderTotal = posSummary ? posSummary.old_order_count : (series.old_order_count || 0);
  const newOrderTotal = posSummary ? posSummary.new_order_count : Math.max(0, orderTotal - oldOrderTotal);

  const convAvg = totalInteractions > 0 ? (orderTotal / totalInteractions) * 100 : 0;
  const convNew = newCustTotal > 0 ? (newOrderTotal / newCustTotal) * 100 : 0;
  const convOld = oldCustTotal > 0 ? (oldOrderTotal / oldCustTotal) * 100 : 0;

  // ── Detailed per-staff activity table (statistics/user) ──
  const us = Array.isArray(userStats) ? userStats : [];
  const totalInboxMsg = us.reduce((s, u) => s + (u.inbox_count || 0), 0);
  const staffDetail = us.map(u => {
    const pos = posByUser.get(u.user_id);
    return {
      user_id: u.user_id,
      name: u.name || 'Không tên',
      privateReply: u.private_reply_count || 0,   // T.nhắn từ b.luận
      comment: u.comment_count || 0,              // Bình luận
      commentSession: u.unique_comment_count || 0,// Phiên tr.lời b.luận
      inbox: u.inbox_count || 0,                  // Tin nhắn (message count)
      inboxSession: u.unique_inbox_count || 0,    // Phiên t.lời t.nhắn
      avgResponse: u.average_response_time || 0,   // seconds
      phone: u.phone_number_count || 0,           // SĐT mang về
      orders: posSummary ? (pos ? pos.order_count : 0) : (u.order_count || 0), // Số đơn chốt
      share: totalInboxMsg > 0 ? ((u.inbox_count || 0) / totalInboxMsg) * 100 : 0,
    };
  }).sort((a, b) => b.inbox - a.inbox);

  return {
    summary: {
      totalInteractions, totalInbox, totalComment,
      newCustTotal, oldCustTotal, newConvTotal,
      orderTotal, newOrderTotal, oldOrderTotal,
      convAvg, convNew, convOld,
      staffCount: staffDetail.length || staff.length,
      posOk: !!posSummary,
      okPages,
      skipped,
      totalInboxMsg,
    },
    staff,
    staffDetail,
    updatedAt: new Date().toISOString(),
  };
}

// ─── Meta Ads spend — nguồn cho thẻ "Lợi nhuận sau ADS" ────────────────────────
// Đọc token System User (vĩnh viễn) từ env FB_ACCESS_TOKEN — set ở Railway
// Variables (KHÔNG nhúng repo). Cộng spend TẤT CẢ tài khoản quảng cáo trong đúng
// khoảng ngày đang xem, quy về VND. Không có token / lỗi → trả null (thẻ hiện —).
const FB_TOKEN = process.env.FB_ACCESS_TOKEN || '';
const FB_GRAPH = 'https://graph.facebook.com/v19.0';

// Tỷ giá quy VND (giống fb-dashboard để khớp số) — giá trị khởi tạo, tự cập nhật
// hằng ngày bởi refreshFxRate() từ open.er-api.com.
const CCY_TO_VND = { VND: 1, USD: 26000, EUR: 29500, GBP: 34000, AUD: 17000,
  CAD: 19000, SGD: 19500, THB: 750, JPY: 175, KRW: 19, CNY: 3600 };
const toVnd = (amt, ccy) => (Number(amt) || 0) * (CCY_TO_VND[ccy || 'VND'] || 1);

// Tỷ giá LIVE — tự cập nhật hằng ngày (miễn phí, không cần key). Lỗi → giữ tỷ giá cũ.
async function refreshFxRate() {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const rates = j?.rates;
    if (!rates || !rates.VND) throw new Error('thiếu tỷ giá VND');
    for (const ccy of Object.keys(CCY_TO_VND)) {
      if (ccy !== 'VND' && rates[ccy]) CCY_TO_VND[ccy] = rates.VND / rates[ccy];
    }
    console.log(`💱 Tỷ giá cập nhật: 1 USD = ${Math.round(rates.VND).toLocaleString('vi-VN')}đ`);
  } catch (err) {
    console.warn(`💱 Lỗi kéo tỷ giá (giữ tỷ giá cũ): ${err.message}`);
  }
}
refreshFxRate();
setInterval(refreshFxRate, 12 * 60 * 60 * 1000);

async function fbGetJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`FB HTTP ${r.status}`);
  return r.json();
}

// Tổng chi tiêu ads (VND) trong khoảng [from, to] (YYYY-MM-DD, VN day). Meta
// time_range inclusive 2 đầu → khớp đúng ngày Pancake đang hiển thị.
// Cache danh sách tài khoản QC + chi tiêu ads → KHÔNG gọi Meta mỗi 30s (tránh
// rate-limit 80004 "too many calls to this ad-account").
let _fbAccounts = { at: 0, val: null };
async function getFbAccountsCached() {
  if (_fbAccounts.val && Date.now() - _fbAccounts.at < 600000) return _fbAccounts.val;  // 10 phút
  _fbAccounts = { at: Date.now(), val: (await fbGetJson(`${FB_GRAPH}/me/adaccounts?fields=id,currency&limit=100`
    + `&access_token=${encodeURIComponent(FB_TOKEN)}`)).data || [] };
  return _fbAccounts.val;
}
const _adSpendCache = new Map();
async function fetchAdSpendCached(from, to) {
  const key = `${from}_${to}`, c = _adSpendCache.get(key);
  if (c && Date.now() - c.at < 300000) return c.val;   // 5 phút
  const val = await fetchAdSpend(from, to);
  _adSpendCache.set(key, { at: Date.now(), val });
  return val;
}

async function fetchAdSpend(from, to) {
  if (!FB_TOKEN) return null;
  const accounts = await getFbAccountsCached();
  if (!accounts.length) return 0;
  const timeRange = JSON.stringify({ since: from, until: to });
  const spends = await Promise.all(accounts.map(async a => {
    try {
      const url = `${FB_GRAPH}/${a.id}/insights?fields=spend&level=account`
        + `&time_range=${encodeURIComponent(timeRange)}`
        + `&access_token=${encodeURIComponent(FB_TOKEN)}`;
      const j = await fbGetJson(url);
      const row = (j.data || [])[0];
      return toVnd(parseFloat(row?.spend || 0), a.currency || 'VND');
    } catch (_) { return 0; }
  }));
  return Math.round(spends.reduce((s, v) => s + v, 0));
}

// ─── KÊNH LIVE: ghép chi ads Live Đại (ngày N) ↔ doanh thu Nhóm Live (ngày N+1) ──
// Sale lên đơn sau 1 ngày Live → doanh thu Nhóm Live ngày N+1 tính cho Live Đại ngày N.

function normViName(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
}
function isLiveDai(name) {
  return normViName(name).includes('live dai');
}
function dayList(from, to) {
  const out = []; let d = from;
  while (d <= to && out.length < 400) { out.push(d); d = nextDay(d); }
  return out;
}
function normDayKey(v) {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);          // 2026-06-27...
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);                   // 27/06/2026
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s.slice(0, 10);
}
async function fbGetAllPages(firstUrl, cap = 8000) {
  const out = []; let url = firstUrl, pages = 0;
  while (url && out.length < cap && pages < 40) {
    const j = await fbGetJson(url);
    out.push(...(j.data || []));
    url = j.paging?.next || null; pages++;
  }
  return out;
}

// Chi ads Live Đại theo từng ngày (VND): { 'YYYY-MM-DD': spend } — null nếu chưa có FB token.
async function fetchLiveDaiSpendByDay(from, to) {
  if (!FB_TOKEN) return null;
  const accounts = await getFbAccountsCached();
  const timeRange = JSON.stringify({ since: from, until: to });
  const byDay = {};
  await Promise.all(accounts.map(async a => {
    try {
      const url = `${FB_GRAPH}/${a.id}/insights?level=campaign`
        + `&fields=campaign_name,spend,date_start&time_increment=1`
        + `&time_range=${encodeURIComponent(timeRange)}&limit=500`
        + `&access_token=${encodeURIComponent(FB_TOKEN)}`;
      const rows = await fbGetAllPages(url);
      for (const r of rows) {
        if (!isLiveDai(r.campaign_name)) continue;
        const d = normDayKey(r.date_start);
        if (d) byDay[d] = (byDay[d] || 0) + toVnd(parseFloat(r.spend || 0), a.currency || 'VND');
      }
    } catch (_) { /* bỏ qua account lỗi */ }
  }));
  for (const d of Object.keys(byDay)) byDay[d] = Math.round(byDay[d]);
  return byDay;
}

// Doanh thu/LN/đơn Nhóm Live theo từng ngày: { 'YYYY-MM-DD': {doanhThu,loiNhuan,donChot} }
async function fetchLiveTeamRevByDay(posToken, shopId, from, to, liveNormSet) {
  const { since, until } = posBounds(from, to);
  const url = `${POS_BASE}/shops/${shopId}/analytics/sale?access_token=${encodeURIComponent(posToken)}`;
  const body = { params: {
    success_status: '1', success_record: 'updated_at', returned_record: 'success_record',
    returned_status: '5', user_type: 'assign', filter: {}, since, until,
    split_by: ['User.id', 'Time.day'], select_fields: POS_BRK_FIELDS } };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`sale per-day HTTP ${res.status}`);
  const j = await res.json();
  const rows = (j?.data?.[0]?.data) || j?.data || [];
  const byDay = {};
  for (const r of rows) {
    const name = (r.user && r.user.name) || '';
    if (liveNormSet.size && !liveNormSet.has(normViName(name))) continue;  // chỉ Nhóm Live
    const day = normDayKey(r['Time.day']);
    if (!day) continue;
    const m = brkRowMetrics(r.result || r.success || {});
    const acc = byDay[day] || { doanhThu: 0, loiNhuan: 0, donChot: 0 };
    acc.doanhThu += m.doanhThu; acc.loiNhuan += m.loiNhuan; acc.donChot += m.donChot;
    byDay[day] = acc;
  }
  return byDay;
}

// ─── API ───────────────────────────────────────────────────────────────────────

app.post('/api/metrics', requireAuth, async (req, res) => {
  const { date, dateTo } = req.body || {};
  const cfg = readJSON(CONFIG_FILE, {});
  const chatToken = cfg.chatToken, shopId = cfg.shopId, pageIds = cfg.pageIds || [];
  const perms = permsOf(req.user);
  if (!chatToken || !Array.isArray(pageIds) || pageIds.length === 0)
    return res.status(400).json({ error: 'Admin chưa cấu hình kết nối Pancake (vào ⚙️ Cấu hình).' });

  let fromStr = date || new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  let toStr = dateTo || fromStr;
  // normalise: make sure from <= to
  if (toStr < fromStr) { const t = fromStr; fromStr = toStr; toStr = t; }
  const dateStr = fromStr === toStr ? fromStr : `${fromStr}…${toStr}`;

  try {
    const engP = fetchEngagements(chatToken, pageIds, fromStr, toStr);
    const userP = fetchUserStats(chatToken, pageIds, fromStr, toStr).catch(e => {
      console.error('userStats:', e.message);
      return [];
    });
    // Pancake dùng 1 JWT cho cả Chat API và POS API.
    // Luôn dùng chatToken cho POS — token này luôn là session hiện tại đang active.
    // (posToken field giữ lại để tương thích config cũ nhưng không dùng nữa.)
    const posP = shopId
      ? fetchPosSale(chatToken, shopId, pageIds, fromStr, toStr).catch(e => {
          console.error('POS:', e.message);
          return null;
        })
      : Promise.resolve(null);
    const ovP = shopId
      ? fetchPosOverview(chatToken, shopId, fromStr, toStr).catch(e => {
          console.error('POS overview:', e.message);
          return null;
        })
      : Promise.resolve(null);
    const brkP = shopId
      ? fetchPosBreakdowns(chatToken, shopId, fromStr, toStr).catch(e => {
          console.error('POS breakdowns:', e.message);
          return null;
        })
      : Promise.resolve(null);
    const adP = fetchAdSpendCached(fromStr, toStr).catch(e => {
      console.error('AdSpend:', e.message);
      return null;
    });

    const [engRes, userStats, posRes, posOv, posBrk, adSpend] =
      await Promise.all([engP, userP, posP, ovP, brkP, adP]);
    const out = buildMetrics(engRes, posRes, userStats);
    out.posOverview = buildPosOverview(posOv);
    out.posBreakdowns = buildPosBreakdowns(posBrk);
    out.adSpend = adSpend;

    // ─── Lọc theo quyền: chỉ trả dữ liệu của mục user được xem ───
    if (!perms.pos && !perms.nhomSale) { out.posOverview = null; out.posBreakdowns = null; out.adSpend = null; }
    if (!perms.chat && !perms.nhomSale) { out.staffDetail = []; out.staff = []; }
    if (!perms.pos) out.adSpend = null;

    console.log(`[${new Date().toLocaleTimeString('vi-VN')}] ${dateStr} — `
      + `${out.summary.staffCount} NV | ${out.summary.totalInteractions} TT | `
      + `${out.summary.orderTotal} đơn${out.summary.posOk ? ' (POS)' : ''}`);

    res.json(out);
  } catch (err) {
    console.error('metrics error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ─── KÊNH LIVE: chi ads Live Đại ngày N ↔ doanh thu Nhóm Live ngày N+1 ─────────
const klCache = new Map();  // "since_until" -> { at, data } — cache 3 phút (endpoint nặng)
app.post('/api/kenh-live', requireAuth, async (req, res) => {
  if (!permsOf(req.user).live) return res.status(403).json({ error: 'Không có quyền xem Kênh Live' });
  const { since, until, liveNames } = req.body || {};
  const cfg = readJSON(CONFIG_FILE, {});
  const token = cfg.chatToken, shopId = cfg.shopId;
  if (!token || !shopId) return res.status(400).json({ error: 'Admin chưa cấu hình kết nối Pancake' });
  if (!since || !until) return res.status(400).json({ error: 'Thiếu khoảng ngày' });
  const cacheKey = `${shopId}_${since}_${until}`;
  const cached = klCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 600000) return res.json(cached.data);   // 10 phút (endpoint nặng)
  try {
    const revFrom = nextDay(since), revTo = nextDay(until);   // doanh thu lệch +1 ngày
    const liveNorm = new Set((liveNames || []).map(normViName));
    let revFailed = false;
    const [adsByDay, revByDay] = await Promise.all([
      fetchLiveDaiSpendByDay(since, until).catch(e => { console.error('LiveDai ads:', e.message); return null; }),
      fetchLiveTeamRevByDay(token, shopId, revFrom, revTo, liveNorm).catch(e => { revFailed = true; console.error('Live rev:', e.message); return {}; }),
    ]);

    const rows = dayList(since, until).map(adDay => {
      const revDay = nextDay(adDay);
      const ads = adsByDay ? (adsByDay[adDay] || 0) : null;
      const rev = revByDay[revDay] || { doanhThu: 0, loiNhuan: 0, donChot: 0 };
      const dt = Math.round(rev.doanhThu), ln = Math.round(rev.loiNhuan);
      return {
        adDay, revDay,
        ads, doanhThu: dt, loiNhuan: ln, donChot: rev.donChot,
        lnSauAds: ads == null ? null : ln - ads,
        mer: (ads && ads > 0) ? dt / ads : null,
      };
    });

    const sum = rows.reduce((s, r) => {
      s.ads += r.ads || 0; s.doanhThu += r.doanhThu; s.loiNhuan += r.loiNhuan; s.donChot += r.donChot;
      return s;
    }, { ads: 0, doanhThu: 0, loiNhuan: 0, donChot: 0 });
    const total = {
      ...sum,
      lnSauAds: adsByDay ? sum.loiNhuan - sum.ads : null,
      mer: sum.ads > 0 ? sum.doanhThu / sum.ads : null,
    };

    // Doanh thu rỗng (không ngày nào có số) hoặc fetch lỗi = KHÔNG đáng tin → đừng cache
    const revEmpty = Object.keys(revByDay).length === 0;
    const partial = revFailed || revEmpty;
    const result = { ok: true, rows, total, adRange: [since, until], revRange: [revFrom, revTo],
      hasFbToken: !!FB_TOKEN, partial };
    // CHỈ cache khi lấy đủ doanh thu → lỗi transient KHÔNG bị "đóng băng" 10 phút, lần sau tự thử lại
    if (!partial) klCache.set(cacheKey, { at: Date.now(), data: result });
    res.json(result);
  } catch (err) {
    console.error('kenh-live error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ─── Debug: probe analytics/sale với params tuỳ ý (dùng token đã lưu) ─────────
// Cho phép thử biến thể tham số ngay trên production để dò format mới của Pancake.
// Body: { date, dateTo, params: { ...override }, drop: ['key', ...] }
app.post('/api/admin/pos-probe', requireAdmin, async (req, res) => {
  const cfg = readJSON(CONFIG_FILE, {});
  if (!cfg.chatToken || !cfg.shopId) return res.status(400).json({ error: 'Chưa cấu hình token/shopId' });
  const { date, dateTo, params, drop, shopId } = req.body || {};
  const from = date || new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const { since, until } = posBounds(from, dateTo || from);
  const sid = shopId || cfg.shopId;
  const p = { success_status: '1', success_record: 'updated_at',
    returned_record: 'success_record', returned_status: '5', user_type: 'assign',
    filter: {}, since, until, split_by: ['User.id'],
    select_fields: ['order_count', 'price', 'customer_count'],
    ...(params || {}) };
  for (const k of (drop || [])) delete p[k];
  const url = `${POS_BASE}/shops/${sid}/analytics/sale?access_token=${encodeURIComponent(cfg.chatToken)}`;
  try {
    const r = await fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: p }), signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 2000); }
    res.json({ httpStatus: r.status, sentParams: p, body: json });
  } catch (err) {
    res.json({ httpStatus: null, sentParams: p, error: err.message });
  }
});

// ─── Debug: GET tuỳ ý trên POS API bằng token đã lưu (vd path: 'shops') ───────
app.post('/api/admin/pos-get', requireAdmin, async (req, res) => {
  const cfg = readJSON(CONFIG_FILE, {});
  if (!cfg.chatToken) return res.status(400).json({ error: 'Chưa cấu hình token' });
  const { path: p, query } = req.body || {};
  if (!p || /[^a-zA-Z0-9_\/-]/.test(p)) return res.status(400).json({ error: 'path không hợp lệ' });
  const q = new URLSearchParams({ access_token: cfg.chatToken, ...(query || {}) });
  try {
    const r = await fetch(`${POS_BASE}/${p}?${q}`, { signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 3000); }
    res.json({ httpStatus: r.status, body: json });
  } catch (err) {
    res.json({ httpStatus: null, error: err.message });
  }
});

// ─── Debug: test POS token directly — trả về lỗi thật từ Pancake ─────────────
app.post('/api/test-pos', requireAdmin, async (req, res) => {
  const { posToken, shopId } = req.body || {};
  if (!posToken || !shopId) return res.status(400).json({ error: 'Thiếu posToken / shopId' });
  const url = `${POS_BASE}/shops/${shopId}/analytics/sale?access_token=${encodeURIComponent(posToken)}`;
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const { since, until } = posBounds(today, today);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: { success_status: '1', success_record: 'updated_at',
        returned_record: 'success_record', returned_status: '5', user_type: 'assign',
        filter: {}, since, until, split_by: ['Time.hour'], select_fields: ['order_count'] } }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    res.json({ httpStatus: r.status, ok: r.ok, body: json || text });
  } catch (err) {
    res.json({ httpStatus: null, ok: false, body: err.message });
  }
});

// Fetch the list of pages the chat token can access (for the setup screen)
app.post('/api/pages', requireAdmin, async (req, res) => {
  const { chatToken } = req.body || {};
  if (!chatToken) return res.status(400).json({ error: 'Thiếu Chat access token' });
  try {
    const url = `${CHAT_BASE}/pages?access_token=${encodeURIComponent(chatToken)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`pages HTTP ${r.status}`);
    const j = await r.json();
    const activated = j?.categorized?.activated || j?.data || [];
    const pages = activated.map(p => ({
      id: String(p.id),
      name: p.name || ('Page ' + String(p.id).slice(-6)),
      platform: (p.platform || '').toLowerCase(),
    }));
    res.json({ pages });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── Ghép nối HÌNH NỀN (Lively wallpaper) ────────────────────────────────────
// Admin bấm "Tạo link hình nền" → sinh mã dùng-một-lần (10'). Dán URL /wp?code=…
// vào Lively → WebView2 mở, server set cookie 30 ngày → khỏi gõ mật khẩu trên nền.
const wpPairs = new Map();   // code -> { u, exp }
function cleanPairs() { const now = Date.now(); for (const [k, v] of wpPairs) if (v.exp < now) wpPairs.delete(k); }

app.post('/api/admin/wp-pair', requireAdmin, (req, res) => {
  cleanPairs();
  const code = crypto.randomBytes(24).toString('base64url');
  wpPairs.set(code, { u: req.user.u, exp: Date.now() + 10 * 60 * 1000 });   // 10 phút
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  res.json({ url: `${proto}://${host}/wp?code=${code}`, expiresInMin: 10 });
});

app.get('/wp', (req, res) => {
  cleanPairs();
  const p = wpPairs.get(String(req.query.code || ''));
  if (!p || p.exp < Date.now()) return res.redirect('/?wp=expired');
  wpPairs.delete(String(req.query.code || ''));   // dùng-một-lần
  const user = findUser(p.u);
  if (!user) return res.redirect('/?wp=expired');
  setSessCookie(res, user);                        // cookie 30 ngày
  res.redirect('/?kiosk=1');
});

app.listen(PORT, '0.0.0.0', () => {
  const ip = Object.values(require('os').networkInterfaces())
    .flat()
    .find(i => i.family === 'IPv4' && !i.internal)?.address ?? '<IP_MÁY>';
  console.log(`\n🚀 Dashboard: http://localhost:${PORT}`);
  console.log(`📱 Cùng mạng:  http://${ip}:${PORT}\n`);
});
