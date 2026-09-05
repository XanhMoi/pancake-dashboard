# Dời pancake-dashboard từ Railway sang VPS (chạy dưới ylg.vn)

App này là Node.js chạy 24/7 + lưu data (tài khoản/cấu hình). VPS thay Railway
làm "máy chủ"; `ylg.vn` chỉ là cái tên trỏ vào VPS. Stack: **systemd** (giữ app
sống) + **Caddy** (tự cấp SSL https). **Không phải sửa code app.**

---

## 0) Cần mua/chuẩn bị

| Thứ | Gợi ý | Ghi chú |
|---|---|---|
| **VPS** | AZDIGI / Vietnix / Mắt Bão (VN) hoặc Vultr / DigitalOcean (Singapore) | 1 vCPU / 1GB RAM / 20GB SSD là dư. ~100–200k/tháng |
| **OS** | **Ubuntu 22.04 hoặc 24.04** | Hướng dẫn này theo Ubuntu |
| **Domain** | `baocao.ylg.vn` (subdomain — khuyên) | apex `ylg.vn` cũng được, xem bước 6 |
| ⚠️ KHÔNG dùng | Hosting cPanel/PHP/WordPress phổ thông | **không chạy được Node.js** |

Sau khi tạo VPS, nhà cung cấp cho anh: **IP** + **user/mật khẩu root** (hoặc SSH key).

---

## 1) SSH vào VPS

```bash
ssh root@IP_CUA_VPS
```

## 2) Lấy code về

```bash
apt-get update && apt-get install -y git
git clone https://github.com/XanhMoi/pancake-dashboard.git /opt/pancake-dashboard
cd /opt/pancake-dashboard
```

## 3) Tạo file .env (điền secret)

```bash
cp deploy/env.example .env
nano .env      # điền FB_ACCESS_TOKEN, ADMIN_PASS, SESSION_SECRET…
```

- **FB_ACCESS_TOKEN**: copy từ `fb-dashboard/.env` trên máy Windows (dòng `FB_ACCESS_TOKEN=…`).
- **PANCAKE_API_KEY**: chuỗi api_key POS 32 ký tự anh đang dùng — hoặc để trống rồi dán trong ⚙️ Cấu hình sau.
- **ADMIN_PASS**: mật khẩu admin anh tự đặt.
- **SESSION_SECRET**: tạo bằng `openssl rand -hex 32` rồi dán vào.

## 4) Chạy script cài (1 lệnh)

```bash
sudo bash deploy/setup.sh baocao.ylg.vn
```

Script tự: cài Node 20 + Caddy → `npm install` → tạo systemd service (auto-restart,
chạy khi VPS khởi động) → cấu hình Caddy cho domain.

Kiểm tra app sống:
```bash
systemctl status pancake-dashboard
journalctl -u pancake-dashboard -f      # xem log realtime (Ctrl+C để thoát)
```

## 5) Mở cổng tường lửa (nếu VPS bật UFW)

```bash
ufw allow 80,443/tcp && ufw allow OpenSSH && ufw --force enable
```

## 6) Trỏ DNS ylg.vn → VPS

Vào trang quản lý DNS của `ylg.vn`, thêm bản ghi:

| Type | Name/Host | Value |
|---|---|---|
| **A** | `baocao` | **IP của VPS** |

- Muốn dùng **apex `ylg.vn`** thay subdomain: thêm bản ghi **A** cho `@` → IP VPS,
  và mở comment khối `ylg.vn` trong `/etc/caddy/Caddyfile` rồi `systemctl reload caddy`.
- Nếu DNS ở **Cloudflare**: để bản ghi ở chế độ **"DNS only" (mây xám)**, đừng bật proxy.

Chờ DNS lan (vài phút–vài tiếng). Xong Caddy **tự cấp SSL** → mở `https://baocao.ylg.vn`.

## 7) Cấu hình lại dashboard (lần đầu)

1. Mở `https://baocao.ylg.vn` → đăng nhập `admin` / (ADMIN_PASS ở .env).
2. Vào **⚙️ Cấu hình**: dán **POS api_key**, **Shop ID** `230277434`, chọn **Page**,
   (dán token chat nếu cần bảng nhân viên).
3. Vào **👑 Quản trị**: tạo lại tài khoản cho nhân viên.

> Tài khoản/cấu hình cũ nằm trên Railway Volume — bản VPS bắt đầu trắng. Muốn bê
> nguyên data cũ sang (giữ tài khoản NV + lịch sử), báo em, em hướng dẫn export
> từ Railway (cần `railway` CLI). Còn không thì cấu hình lại như trên là đủ.

---

## Cập nhật code sau này

```bash
cd /opt/pancake-dashboard && git pull && npm install --omit=dev && systemctl restart pancake-dashboard
```

## Vẫn giữ Railway làm dự phòng
Đừng xoá app Railway ngay. Chạy VPS ổn định vài ngày, chắc chắn rồi mới tắt Railway.
URL railway.app cũ vẫn sống song song trong lúc chuyển.
