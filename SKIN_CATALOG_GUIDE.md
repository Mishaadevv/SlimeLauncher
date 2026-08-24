# Где взять Skin Directory URL

Skin Directory — это твой личный сервер скинов. Без него скины работают только в одной сети (LAN) или в сети лаунчера (Network-таб). С каталогом — на **любом** стороннем сервере через интернет.

Без URL (поле пустое) — всё как раньше. С URL — скины видны между любыми двумя лаунчерами с одинаковым URL.

### Быстрый тест (2 минуты, без деплоя)

1. На одном компе запусти сервер:
   ```bash
   node server/server.mjs
   # SlimeLauncher skin directory listening on :8080
   ```
2. Узнай свой LAN IP: `ipconfig` → `192.168.1.X`
3. Всем игрокам пропиши в лаунчере: **Settings → Advanced → Skin directory URL** = `http://192.168.1.X:8080`
4. Смените скины, зайдите на любой сторонний сервер — скины видны.

Через интернет без VPS — через ngrok:
```bash
npx ngrok http 8080
# Forwarding https://a1b2-...ngrok-free.app -> http://localhost:8080
```
URL `https://a1b2-...ngrok-free.app` вставь всем в настройки.

### Навсегда (бесплатно)

**Render.com** (самый простой):
1. Залей папку `server/` в GitHub (отдельный репо)
2. render.com → New Web Service → подключи репо → Build: `npm install` не нужен, Start: `node server.mjs`
3. Получишь `https://slime-skins.onrender.com` — вставь в лаунчер.

**Fly.io / Railway** — аналогично, `node server.mjs`, переменная `PORT` уже учтена.

**VPS (Ubuntu):**
```bash
scp -r server/ root@your-vps:/opt/slime-skins
ssh root@your-vps
cd /opt/slime-skins && npm init -y # не нужен, deps нет
pm2 start server.mjs --name slime-skins -- --port 8080
# nginx: proxy_pass http://127.0.0.1:8080; + certbot --nginx -d skins.yourdomain.com
```
URL: `https://skins.yourdomain.com`

### Проверка

1. `GET https://твой-урл/health` → `ok`
2. Поставь скин → зайди в игру → выйди → на другом компе зайди на тот же сторонний сервер — скин виден.
3. Данные лежат в `server/data.json`, у клиента кэш 24ч в `remote_skins`.

### Не нужно?

Оставь поле пустым. LAN и Network-таб работают без каталога.
