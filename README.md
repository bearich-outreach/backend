# Bearich Outreach — Backend

API untuk sistem otomasi outreach & pipeline freelance web developer. Dibangun dengan Express + TypeScript + MySQL.

Frontend terpisah: lihat repo **bearich-frontend** (Next.js, deploy di Vercel).

## Menjalankan lokal

```bash
npm install
npm run dev     # http://localhost:4000 (tsx watch)
# atau
npm run build && node dist/index.js
```

Buat database MySQL `bearich` (tabel dibuat otomatis saat pertama berjalan):

```sql
CREATE DATABASE bearich CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Salin `.env.example` → `.env` dan isi kredensial.

## Endpoint utama

- `POST /api/login`, `GET /api/logout`, `GET /api/me`
- `GET /api/stats`, `GET /api/outreach`
- `GET|POST /api/prospects`, `POST /api/prospects/import`, `GET /api/prospects/export`
- `PATCH|DELETE /api/prospects/:id`
- `POST /api/prospects/:id/{status|advance|note|message}`
- `GET /api/prospects/:id/activities`
- `GET|POST /api/settings`

## Deploy container (Portainer)

1. Build image di VM:
   ```bash
   docker build -t bearich-api:latest .
   ```
2. Buat stack di Portainer dari `docker-compose.yml`. Isi rahasia (`DB_PASSWORD`, `ADMIN_PASSWORD`, `SESSION_SECRET`) di panel Environment variables.
3. Backend join network `global-network` yang sama dengan container MySQL `global-mysql` (resolusi nama via Docker network).
4. Reverse proxy: `deploy/nginx-bearich-api.conf` (Nginx VM) → `127.0.0.1:4000`, lalu `certbot --nginx -d bearich-outreach.duckdns.org`.

> Backend wajib HTTPS (duckdns + certbot) karena frontend HTTPS dilarang memanggil API HTTP (mixed content), dan cookie lintas-situs butuh `SameSite=None; Secure`.

## Environment variables

| Variabel | Keterangan |
|----------|------------|
| `DB_HOST` | `global-mysql` di container / `localhost` lokal |
| `DB_PORT` | 3306 |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Kredensial MySQL |
| `PORT` | Port listen (4000) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Kredensial login |
| `SESSION_SECRET` | Rahasia HMAC session cookie |
| `CORS_ORIGIN` | Origin frontend, mis. `https://bearich-outreach.vercel.app` |
| `COOKIE_SAMESITE` | `none` untuk lintas-situs |
| `NODE_ENV` | `production` saat deploy |

## Struktur

```
src/
  index.ts     # server Express + routes
  db.ts        # koneksi & query MySQL
  auth.ts      # login + session cookie (HMAC)
  ai.ts        # generator pesan (DeepSeek)
  outreach.ts  # pipeline & follow-up
  store.ts     # helper
  types.ts     # tipe data
deploy/        # nginx config
schema.sql     # skema database (opsional)
```