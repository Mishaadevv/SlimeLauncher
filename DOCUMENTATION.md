# SlimeLauncher — Documentation / Документация

> **SlimeLauncher 1.18.0** — open-source Minecraft launcher for Windows (Electron + React + better-sqlite3).  
> **SlimeLauncher 1.18.0** — опенсорс лаунчер Майнкрафта для Windows (Electron + React + better-sqlite3).

This file is for **humans** (first time with Minecraft) and for **AI** (structured overview). Two languages in one file.

---

# ENGLISH — For humans (Minecraft + SlimeLauncher from zero)

## 1. What is Minecraft? (30 sec)
Minecraft is a sandbox game: you break blocks, build, survive monsters. Two editions: **Java Edition** (PC, mods, servers) — the one SlimeLauncher launches. To play online on premium servers you need a **Microsoft account** that owns Java Edition. To play offline/cracked you can play with any nickname.

## 2. What is SlimeLauncher?
A replacement for the official Mojang launcher. It can:
- launch any Minecraft version (from Classic `c0.0.11` to `26.2`, snapshots)
- add loaders: `vanilla / fabric / forge / neoforge / quilt`
- install mods/maps/modpacks with 1 click
- manage up to 8 accounts (`Accounts`) — offline (no license) and Microsoft (licensed)
- give offline players **custom skins/capes** visible to other SlimeLauncher users (local `SkinServer` + `ely.by` fallback like TLauncher)
- show friends on LAN, create/join networks over internet (like Radmin VPN, but inside the launcher)
- run your own dedicated server (`Paper / Vanilla`) with 1 click
- record gameplay / auto-backup worlds / Discord Rich Presence

## 3. Installation
1. Download `SlimeLauncher Setup 1.18.0.exe` from `release/` or GitHub Releases.
2. Run installer → choose folder → check `Install ZeroTier / Radmin VPN` if you want to play over internet.
3. On first run the launcher will ask to install the VPN you checked — click `Install`.
4. Data is stored in: `%APPDATA%\slimelauncher\data\slimelauncher.db` (accounts, instances) and `%USERPROFILE%\.slimelauncher\minecraft\` (versions, mods, saves).

## 4. First launch — Accounts
Open `Accounts` in the sidebar (or `Sign In` on welcome screen).
- **Offline account** — pick any nickname `3-24` chars `a-z 0-9 _ -`. **CaSe matters**: `Sigmultra452 ≠ sigmultra452` — the server remembers the exact case and kicks `Wrong case! Use: Sigmultra452` if you join with the wrong one. Create with the exact case the server expects. Limit 8 accounts.
- **Microsoft account** — click `Link Microsoft account` → browser → enter code `ABCD-EFGH` → approve. Requires owned Java Edition, otherwise `NOT_FOUND`. Token lives 1 hour, auto-refreshes via `refresh_token` (`microsoft.ts:132`).

Active account (dot) is used for launching, skins, Friends and Network. Switch with `Switch`.

## 5. Instances — Your Minecraft profiles
`Instances` → `Create Instance`:
- `Minecraft version` — e.g. `1.20.1`, `1.21.11`, `26.2`, snapshot `26w01a`
- `Loader` — `vanilla` (no mods), `fabric` (light), `forge` (heavy), `neoforge`, `quilt`
- `RAM` / `JVM args` — default `4096M` is fine.

Click `Play` — first launch downloads vanilla client + libraries + assets (progress bar). If Java is missing, the launcher auto-downloads correct version via `Adoptium` (`minecraft.ts:1386` `getAdoptiumApiUrl`): `Java 8` for `≤1.16`, `Java 17` for `1.17-20.4`, `Java 21` for `1.20.5+`, `Java 25` for `26.x`.

## 6. Skins & Capes — How to make them work (like TLauncher)
Open `Skins`. You have 3 layers:

**Option 1 — Quick (SlimeLauncher only, out of the box on LAN):**
Upload `PNG 64×64 … 1024×1024` (skin) and `64×32 … 1024×512` (cape) right here in `Offline skin` block. Visible to anyone who also uses SlimeLauncher — in singleplayer, `Open to LAN` and `Network` tab. On foreign servers without the launcher others won’t see it. HD skins are auto-downscaled to `64×64` for vanilla; enable `HD textures in-game` below to serve full HD (needs OptiFine/CustomSkinLoader).

**Option 2 — Like TLauncher, on any server:**
Register at `https://ely.by` with **the same nickname as in the launcher (respect CaSe!)**, upload skin/cape there. `SlimeLauncher 1.18+` pulls it from `https://skinsystem.ely.by` automatically (`skins/<nick>.png` + `cloaks/<nick>.png`, `301 → http://ely.by/storage/...` handled in `elyby.ts:23`). No setup. You’ll be seen on any cracked server, even without the launcher on the other side (if they have `Ely.by`/`SkinsRestorer` with ely support).

**For licensed Microsoft accounts:** official Mojang skin (`minecraft.net`) is visible everywhere. Custom `SlimeLauncher` look (`Skins → Custom look`) overrides it only for `SlimeLauncher` peers.

Hint logic: `offline_skins.username` is looked up case-insensitively (`lower(username)=lower(?)` `skins.ts:118`, `presence.ts:394`) but `offlineUuid` is case-sensitive (`OfflinePlayer:<nick>` `skin-server.ts:68`) — so `Sigmultra452 ≠ sigmultra452`.

## 7. How to download Addons — Mods, Maps, Modpacks (step by step)

> If you never installed a mod — start here. All downloads are inside the launcher, you don’t need a browser.

### 7.1 Mods — new blocks, weapons, magic
**What is a mod?** A `.jar` file that adds content. Every mod needs a **loader** (`fabric` / `forge` / `neoforge` / `quilt`). Vanilla instances can’t run mods.

**Via catalog (recommended):**
1. `Instances` → check your instance has a loader (badge `fabric`/`forge`). If `vanilla` → `Create Instance` → choose `fabric` (light, 1.16+) or `forge` (heavy, 1.12.2/1.16.5/1.20.1).
2. Go to `Mods` tab → top dropdown `Select instance` → pick that instance (`Installing into: My Fabric 1.20.1`).
3. Search bar → type `jei` / `sodium` / `create` → choose source `Modrinth` (faster) or `CurseForge`. Filters: `All` / `Most downloaded` / `Recently updated`, version dropdown `All versions`.
4. Click a mod → see screenshots (`CurseForge screenshots` `handlers/mods.ts`), `Available versions` → pick version that matches your `Minecraft version + loader` (green `installed` badge means you already have it). Click `Install` → progress bar in `Downloads` (top-right). When done, `Mods installed: 5` counter grows, mod appears in list with `enabled` toggle.
5. `Update all` — bottom of installed list — checks Modrinth/CurseForge for newer files and updates all outdated at once.

**Manual:** download `.jar` from browser → `Mods` → `Open mods folder` (or `%USERPROFILE%\.slimelauncher\minecraft\<instance>\mods\`) → drop the `.jar` → `Refresh` in launcher. To disable, click toggle (renames `.jar.disabled`).

**Tips:** some mods need a library (`fabric-api`, `architectury`, `geckolib`). If game crashes `NoClassDefFoundError`, install the missing dependency shown in `latest.log`.

### 7.2 Maps — worlds / saves
**What is a map?** A `saves/<world>/` folder (or `.zip` with it).

**Via catalog:**
1. `Maps` tab → `Select instance` → pick where you want to play the map.
2. Search `Oneblock`, `Horror` → `Modrinth` / `CurseForge` → `Install` → launcher zips? No, it downloads `.zip` / `.mrpack` and extracts via `yauzl` → `.../saves/<MapName>/`. Progress in `Downloads`.
3. Launch that instance → `Singleplayer` → new world appears.

**Manual:** download `.zip` map → `Maps` → `Open saves folder` → unzip so that `.../saves/MyMap/level.dat` exists.

### 7.3 Modpacks — 100 mods in 1 click
Modpack = instance + mods + configs packed as `manifest.json` (CurseForge) or `modrinth.index.json` (Modrinth).

1. `Modpacks` tab (grouped next to `Mods` in sidebar) → search `Fabulously Optimized`, `Better MC`, `SkyFactory`.
2. Click `Install` → launcher downloads the pack `.zip`, parses the manifest (`handlers/modpacks.ts`, `archiver`/`yauzl`), **creates a NEW instance** with correct `Minecraft version + loader` automatically (you see `Minecraft 1.20.1 (fabric)` appear in `Instances`), downloads all 100+ mods and `config/`/`kubejs/` files.
3. Play the new instance. Don’t install a modpack into an existing vanilla instance — let the launcher create the new one.

### 7.4 Resource Packs / Shaders (manual for now)
The catalog for `Resource Packs`/`Shaders` is not yet in the UI — drop them manually:
- Resource pack `.zip` → `.../<instance>/resourcepacks/` → in game `Options → Resource Packs`.
- Shader `.zip` (needs `Iris`/`OptiFine` mod) → `.../<instance>/shaderpacks/`.

### 7.5 Where files go (for AI)
- Instance root: `%USERPROFILE%\.slimelauncher\minecraft\<id>\`
- `mods/` `<id>.jar` (`mods` table `mods(id,instance_id,slug,name,version,enabled)`)
- `saves/<world>/` (`maps` table)
- `downloads` queue (`downloads` table, `DownloadManager` `download-manager.ts`) with `queued/downloading/completed/error`, retry/resume via `Content-Range`.

**Common errors:**
- `No compatible versions` → modpack has no build for your instance’s version — pick another instance or all versions.
- `Vanilla instance` banner in `Mods` → create a loader instance first.
- Loader install fails `ResolutionException` → fixed in `1.8.10` by replacing authlib jar fully (`minecraft.ts:810`).

## 8. Friends & LAN
`Friends` → `Add friend` by nickname. When both run `SlimeLauncher` on the **same LAN/Wi-Fi** (not guest hotspot), they appear as `Online · In menu / LAN world on port N` via multicast `239.255.77.7:47777` (`presence.ts:14`) + directed broadcast. If `Offline`, check: same Wi-Fi, Windows Firewall allowed `SlimeLauncher` (Private networks), no VPN routing traffic away.

LAN worlds also appear in Minecraft → `Multiplayer` automatically — ensure same version + same mods (`presence.ts:358` `modsHash`).

## 9. Network — Play over internet without port-forward
Like Radmin VPN but inside the launcher:
- `Network` → `Create Network` → you get a key `26.186.110.31:xxxxx` (or `10.0.0.10` for LAN). Share the key.
- Friend → `Join Network` → paste key → `Peer connected`. Chat works instantly.
- Host opens a world `Open to LAN` in Minecraft — its port is auto-detected from `logs/latest.log` (`Started serving on <port>` `presence.ts:108`) and announced to peers, plus a local proxy `127.0.0.1:<port>` is broadcast via `224.0.2.60:4445` so it appears in `Multiplayer` even across different networks (ZeroTier IP fallback `skin-server.ts:245`).
- Enable `Internet mode` (UPnP) to open router port automatically.

## 10. Your own server (Dedicated)
`Instances` → `Your servers` → `Create server`: choose `vanilla` or `paper`, version, `port` (default `25565`), `ram`, `MOTD`, `online_mode` (off = cracked, on = licensed). Click `Start` — console shows log, UPnP opens port. Share your public IP.

## 11. Other features
- `Recordings` — `F8` record, `F9` screenshot, `ffmpeg` auto-installed to `%APPDATA%\slimelauncher\tools\`
- `World backups` — before every launch saves are zipped to `world-backups/<instance>/`, keep `N` latest (`Settings → World backups`)
- `Settings` — `Minecraft directory`, `Java path`, `RAM`, `Discord Rich Presence` (needs `discord(ClientId)`), `Skin directory URL` (optional self-hosted `server/server.mjs` `PUT /api/skins/<nick>`), `Languages: en/ru` (`i18n.ts`).

## 12. Troubleshooting (quick)
- `Invalid nickname case! Use: X` → `Accounts` → delete old nick → `Add offline` with **exact** `X` (CaSe).
- `Duplicate accounts` before `1.17.2` → fixed by `UNIQUE(user_id/ms_id)` `database.ts:157` + `backfill` `WHERE NOT EXISTS`. If still duplicates, delete `%APPDATA%\slimelauncher\data\slimelauncher.db`.
- `Microsoft session expired` → `Accounts` → remove → `Link Microsoft` again. If `NOT_FOUND`, that account doesn’t own Java.
- `Skin is Steve` → `Accounts` active nick must match `ely.by` nick (CaSe). Upload `PNG` in `Skins` and restart game. Check log `slimelauncher.log` for `ely.by hit` / `Offline skins mod injected`.
- `Java required` → let the launcher download it, or set `Settings → Default Java` manually.

---

# РУССКИЙ — Для людей (Майнкрафт + SlimeLauncher с нуля)

## 1. Что такое Майнкрафт? (30 сек)
Песочница: ломаешь блоки, строишь, выживаешь против монстров. Два издания: **Java Edition** (ПК, моды, сервера) — его и запускает SlimeLauncher. Для лицензионных серверов нужен **Microsoft аккаунт** с купленной Java-версией. Для пиратки можно играть с любым ником.

## 2. Что такое SlimeLauncher?
Замена официальному лаунчеру Mojang. Умеет:
- запускать любую версию Майнкрафта (`c0.0.11` … `26.2`, снапшоты)
- добавлять загрузчики `vanilla / fabric / forge / neoforge / quilt`
- ставить моды/карты/сборки в 1 клик
- держать до 8 аккаунтов (`Аккаунты`) — оффлайн и лицензия
- давать оффлайн-игрокам кастомные скины/плащи видные другим с этим лаунчером (локальный `SkinServer` + фолбэк на `ely.by` как в `TLauncher`)
- показывать друзей в LAN, создавать/вступать в сети через интернет (как `Radmin VPN`, но внутри)
- поднять свой выделенный сервер (`Paper / Vanilla`) в 1 клик
- писать геймплей / автобэкапы миров / `Discord Rich Presence`

## 3. Установка
1. Скачай `SlimeLauncher Setup 1.18.0.exe` из `release/` или `GitHub Releases`.
2. Запусти → выбери папку → галочки `Установить ZeroTier / Radmin VPN` если хочешь играть через интернет.
3. При первом запуске спросит установить выбранный VPN — нажми `Установить`.
4. Данные: `%APPDATA%\slimelauncher\data\slimelauncher.db` (аккаунты, инстансы) и `%USERPROFILE%\.slimelauncher\minecraft\` (версии, моды, сейвы).

## 4. Первый запуск — Аккаунты
Открой `Аккаунты` в боковом меню (или `Войти` на приветствии).
- **Оффлайн** — любой ник `3-24` символа `a-z 0-9 _ -`. **Регистр важен**: `Sigmultra452 ≠ sigmultra452` — сервер запоминает точный регистр и кикает `Неверный регистр ника! Используйте: Sigmultra452`. Создавай с тем регистром что ждет сервер. Лимит 8.
- **Microsoft** — `Привязать Microsoft` → браузер → код `ABCD-EFGH` → подтвердить. Нужна купленная Java, иначе `NOT_FOUND`. Токен живет 1 час, автообновляется (`microsoft.ts:132`).

Активный аккаунт (точка) используется для запуска, скинов, `Друзей` и `Сети`. Переключение `Переключить`.

## 5. Инстансы — Твои профили Майнкрафта
`Инстансы` → `Создать инстанс`:
- `Версия Minecraft` — `1.20.1`, `1.21.11`, `26.2`, снапшот `26w01a`
- `Загрузчик` — `vanilla` (без модов), `fabric`, `forge`, `neoforge`, `quilt`
- `ОЗУ` / `JVM аргументы` — по умолчанию `4096M` ок.

`Играть` — первый запуск качает клиент + библиотеки + ассеты (прогресс-бар). Если нет `Java`, лаунчер сам скачает нужную через `Adoptium` (`minecraft.ts:1386`): `Java 8` для `≤1.16`, `17` для `1.17-20.4`, `21` для `1.20.5+`, `25` для `26.x`.

## 6. Скины и плащи — Как сделать чтобы работали (как в TLauncher)
Открой `Скины`. 3 слоя:

**Вариант 1 — быстро (только SlimeLauncher, из коробки в LAN):**
Залей `PNG 64×64 … 1024×1024` (скин) и `64×32 … 1024×512` (плащ) здесь в блоке `Offline skin`. Увидят друзья у кого тоже `SlimeLauncher` — в одиночке, `Открыть для сети` и во вкладке `Сеть`. На чужих серверах без лаунчера не увидят. HD автоматом даунскейлится до `64×64` для ванили; включи `HD текстуры в игре` ниже чтобы отдавать полный HD (нужен `OptiFine/CustomSkinLoader`).

**Вариант 2 — как в TLauncher, на любом сервере:**
Зарегистрируйся на `https://ely.by` под **тем же ником что в лаунчере (соблюдай РеГиСтР!)**, залей там скин/плащ. `SlimeLauncher 1.18+` сам подтянет их с `https://skinsystem.ely.by` (`skins/<ник>.png` + `cloaks/<ник>.png`, `301 → http://ely.by/storage/...` `elyby.ts:23`). Ничего настраивать не надо. Увидят на любом пиратском сервере, даже без лаунчера у других (если у них плагин `Ely.by`/`SkinsRestorer` с поддержкой `ely`).

**Для лицензии:** официальный скин с `minecraft.net` виден везде. Кастомный `SlimeLauncher` (`Скины → Кастомный образ`) перекрывает его только для `SlimeLauncher`-пиров.

Подсказка: `offline_skins.username` ищется `lower(username)=lower(?)` `skins.ts:118`, но `offlineUuid` регистрозависим (`OfflinePlayer:<ник>` `skin-server.ts:68`) — поэтому `Sigmultra452 ≠ sigmultra452`.

## 7. Как качать дополнения — Моды, Карты, Сборки (по шагам)

> Если ни разу не ставил мод — начни отсюда. Все качается внутри лаунчера, браузер не нужен.

### 7.1 Моды — новые блоки, оружие, магия
**Что такое мод?** Файл `.jar` который добавляет контент. Каждому моду нужен **загрузчик** (`fabric` / `forge` / `neoforge` / `quilt`). Ванильные инстансы моды не тянут.

**Через каталог (рекомендуется):**
1. `Инстансы` → проверь что инстанс с загрузчиком (бейдж `fabric`/`forge`). Если `vanilla` → `Создать инстанс` → выбери `fabric` (легкий, `1.16+`) или `forge` (тяжелый, `1.12.2`/`1.16.5`/`1.20.1`).
2. Иди во вкладку `Моды` → сверху выпадашка `Выбери инстанс` → выбери его (`Устанавливается в: Мой Fabric 1.20.1`).
3. Строка поиска → вбей `jei` / `sodium` / `create` → выбери источник `Modrinth` (быстрее) или `CurseForge`. Фильтры: `Все` / `По загрузкам` / `Недавно обновлены`, выпадашка версий `Все версии`.
4. Кликни на мод → увидишь скриншоты (`CurseForge screenshots` `handlers/mods.ts`), `Доступные версии` → выбери версию под твою `версию Minecraft + загрузчик` (зеленый бейдж `установлено` значит уже есть). Нажми `Установить` → прогресс в `Загрузки` (правый верх). Когда готово, счетчик `Модов установлено: 5` растет, мод в списке с переключателем `вкл`.
5. `Обновить всё` — внизу списка установленных — проверит `Modrinth/CurseForge` и обновит все устаревшие за раз.

**Вручную:** скачай `.jar` из браузера → `Моды` → `Открыть папку модов` (или `%USERPROFILE%\.slimelauncher\minecraft\<id>\mods\`) → кинь `.jar` → `Обновить` в лаунчере. Чтобы выключить — кликни переключатель (переименует в `.jar.disabled`).

**Подсказки:** некоторым модам нужна библиотека (`fabric-api`, `architectury`, `geckolib`). Если игра крашится `NoClassDefFoundError`, поставь зависимость из `latest.log`.

### 7.2 Карты — миры / сохранения
**Что такое карта?** Папка `saves/<мир>/` (или `.zip` с ней).

**Через каталог:**
1. Вкладка `Карты` → `Выбери инстанс` → куда хочешь играть карту.
2. Поиск `Oneblock`, `Horror` → `Modrinth` / `CurseForge` → `Установить` → лаунчер скачает `.zip` / `.mrpack` и распакует через `yauzl` → `.../saves/<НазваниеКарты>/`. Прогресс в `Загрузках`.
3. Запусти тот инстанс → `Одиночная игра` → мир появился.

**Вручную:** скачай `.zip` карты → `Карты` → `Открыть папку сохранений` → распакуй чтобы было `.../saves/МояКарта/level.dat`.

### 7.3 Сборки — 100 модов в 1 клик
Сборка = инстанс + моды + конфиги упакованные как `manifest.json` (`CurseForge`) или `modrinth.index.json` (`Modrinth`).

1. Вкладка `Сборки` (рядом с `Модами` в боковом меню) → поиск `Fabulously Optimized`, `Better MC`, `SkyFactory`.
2. Нажми `Установить` → лаунчер скачает `.zip` сборки, распарсит манифест (`handlers/modpacks.ts`, `archiver`/`yauzl`), **создаст НОВЫЙ инстанс** с правильной `версией Minecraft + загрузчиком` автоматом (увидишь `Minecraft 1.20.1 (fabric)` в `Инстансах`), скачает все 100+ модов и папки `config/`/`kubejs/`.
3. Играй новым инстансом. Не ставь сборку в существующий `vanilla` — пусть создаст новый.

### 7.4 Ресурс-паки / Шейдеры (пока вручную)
Каталога для них еще нет в UI — кидай руками:
- Ресурс-пак `.zip` → `.../<инстанс>/resourcepacks/` → в игре `Настройки → Ресурс-паки`.
- Шейдер `.zip` (нужен мод `Iris`/`OptiFine`) → `.../<инстанс>/shaderpacks/`.

### 7.5 Куда падают файлы (для ИИ)
- Корень инстанса: `%USERPROFILE%\.slimelauncher\minecraft\<id>\`
- `mods/` `<id>.jar` (таблица `mods(id,instance_id,slug,name,version,enabled)`)
- `saves/<мир>/` (таблица `maps`)
- Очередь `downloads` (`downloads` таблица, `DownloadManager` `download-manager.ts`) со статусами `queued/downloading/completed/error`, ретрай/резюм через `Content-Range`.

**Частые ошибки:**
- `Нет совместимых версий` → у сборки нет билда под версию твоего инстанса — выбери другой инстанс или `Все версии`.
- Баннер `Ванильный инстанс` в `Модах` → создай инстанс с загрузчиком.
- Установка загрузчика падает `ResolutionException` → пофикшено в `1.8.10` заменой `authlib.jar` целиком (`minecraft.ts:810`).

## 8. Друзья и LAN
`Друзья` → `Добавить друга` по нику. Когда оба в `SlimeLauncher` в **одной LAN/Wi-Fi** (не гостевой), они появятся как `Онлайн · В меню / Локальный мир, порт N` через мультикаст `239.255.77.7:47777` (`presence.ts:14`) + `directed broadcast`. Если `Оффлайн`, проверь: одна Wi-Fi, `SlimeLauncher` разрешен в брандмауэре Windows (Частные сети), VPN не уводит трафик.

Локальные миры также появляются в `Minecraft → Сетевая игра` автоматически — нужна одинаковая версия + одинаковые моды (`presence.ts:358` `modsHash`).

## 9. Сеть — Игра через интернет без проброса портов
Как `Radmin VPN`, но внутри:
- `Сеть` → `Создать сеть` → получишь ключ `26.186.110.31:xxxxx` (или `10.0.0.10` для `LAN`). Поделись ключом.
- Друг → `Вступить в сеть` → вставь ключ → `Peer connected`. Чат сразу работает.
- Хост открывает мир `Открыть для сети` — порт ловится из `logs/latest.log` (`Started serving on <port>` `presence.ts:108`) и объявляется пирам, плюс локальный прокси `127.0.0.1:<порт>` бродкастится через `224.0.2.60:4445` чтобы мир появился в `Сетевая игра` даже через разные сети (`ZeroTier` фолбэк `skin-server.ts:245`).
- Включи `Интернет-режим` (`UPnP`) чтобы роутер открыл порт автоматом.

## 10. Свой сервер (Выделенный)
`Инстансы` → `Свои серверы` → `Создать сервер`: выбери `vanilla` или `paper`, версию, `порт` (`25565`), `ОЗУ`, `MOTD`, `online_mode` (`выкл = пиратка`, `вкл = только лицензия`). `Запустить` — в консоли лог, `UPnP` откроет порт. Поделись публичным `IP`.

## 11. Остальное
- `Записи` — `F8` запись, `F9` скрин, `ffmpeg` ставится в `%APPDATA%\slimelauncher\tools\`
- `Бэкапы миров` — перед каждым запуском сейвы зипуются в `world-backups/<инстанс>/`, хранить `N` последних (`Настройки → Бэкапы миров`)
- `Настройки` — `Папка Minecraft`, `Путь к Java`, `ОЗУ`, `Discord Rich Presence` (нужен `discord(ClientId)`), `URL каталога скинов` (опциональный свой `server/server.mjs` `PUT /api/skins/<ник>`), `Языки: en/ru` (`i18n.ts`).

## 12. Частые проблемы
- `Неверный регистр ника! Используйте: X` → `Аккаунты` → удали старый ник → `Добавить оффлайн` с **точным** `X` (регистр).
- `Дубли аккаунтов` до `1.17.2` → пофикшено `UNIQUE(user_id/ms_id)` `database.ts:157` + `backfill` `WHERE NOT EXISTS`. Если остались дубли — удали `%APPDATA%\slimelauncher\data\slimelauncher.db`.
- `Сессия Microsoft истекла` → `Аккаунты` → удали → `Привязать Microsoft` заново. Если `NOT_FOUND` — на этом аккаунте нет купленной Java.
- `Скин Стив` → `Аккаунты` активный ник должен совпадать с `ely.by` ником (регистр!). Залей `PNG` в `Скины` и перезапусти игру. В логе ищи `ely.by hit` / `Offline skins mod injected`.
- `Нужна Java` → дай лаунчеру скачать, или укажи `Настройки → Java по умолчанию` вручную.

---

# FOR AI — Structured overview

**Stack:** `Electron 33`, `React 18`, `Vite 6`, `zustand 4`, `better-sqlite3 11` (`WAL`), `electron-store`, `https/http` (no extra deps for skins).

**DB:** `DatabaseService` `electron/services/database.ts` — SQLite `slimelauncher.db`. Tables: `users(id,username,email,password_hash)`, `sessions(token,user_id)`, `microsoft_accounts(id,username,uuid,access_token,refresh_token,expires_at,is_active)`, `saved_accounts(id,kind,nick,user_id,ms_id,created_at)` + `UNIQUE INDEX idx_saved_accounts_user_id/ms_id WHERE NOT NULL` (1.17.2), `offline_skins(username PK, skin_data base64, cape_data, variant)`, `remote_skins, friends, instances, mods, maps, downloads, settings, world_backups, dedicated_servers, recordings`. `backfillSavedAccounts()` ensures `saved_accounts` has row per `users/microsoft_accounts`.

**IPC:** `shared/ipc.ts` `IPC` const, `electron/preload.ts` exposes `window.slime.*`. Handlers: `handlers/accounts.ts` (`ACCOUNTS_*`), `auth.ts` (`AUTH_*`), `microsoft.ts` (`MS_*`), `skins.ts` (`SKIN_*`), `minecraft.ts` (`MC_LAUNCH`), `java.ts`, `mods/maps/instances/network/presence` etc. `HandlerDeps` in `handlers/types.ts`.

**Auth flows:**
- Offline: `ACCOUNTS_ADD_OFFLINE` `accounts.ts:110` validates `^[a-zA-Z0-9_\-]+$`, checks `lower(nick)` clash, creates `users` + `saved_accounts` random id + `activateOfflineUser` (`sessions` + `settings:slime_session_token`). `offlineUuid = md5("OfflinePlayer:<nick>") v3/4 bits` `skin-server.ts:68` `minecraft.ts:1653`.
- Microsoft: `MS_DEVICE_CODE` `microsoft.ts:202` `device_code` → `MS_COMPLETE` polls `TOKEN_URL` → `XBL → XSTS → MC` `getMcToken` → `fetchProfile` `MC_PROFILE_URL` → `INSERT microsoft_accounts` + `ensureSavedAccount`. `refreshMsTokenIfExpired` checks `^eyJ` + `expires_at`, uses `refresh_token` grant. `ACCOUNTS_SET_ACTIVE` proactively refreshes but no longer blocks (`accounts.ts:149`).

**Launch:** `handlers/minecraft.ts:538` `MC_LAUNCH` — resolves `launchId` (`findLoaderProfileId`), merges `VersionProfile` (`mergeVersionProfiles` `minecraft.ts:51`, `dedupeLibraries` `minecraft.ts:94`), checks/sha1 verifies client jar + libraries, checks assets (`assetIndex` + `pre-1.6` legacy), resolves `authUsername/Uuid/Token` (MS first, else `sessions`), finds Java (`findOrDownloadJava` `Adoptium` `getAdoptiumApiUrl`), builds classpath (`buildClasspath`), injects offline-skins mod (`patchAuthlibForLocalServer` `skin-patch.ts` replaces authlib jar on classpath for `1.7+`, or `patchClientJarForLegacySkins` for `<1.7`), sets `-Dminecraft.api.*.host=http://127.0.0.1:port` (all 5 hosts) + JVM/game args (`resolveValue`), spawns `java`.

**Skins system:**
- `SkinServer` `electron/services/skin-server.ts` — `http` on `0.0.0.0:0`, `getSessionHost()=http://127.0.0.1:port`, `hostIp=detectLanIp()` (`192.168/10/172` preferred over `26.x` VPN `skin-server.ts:58`). Intercepts `/session/minecraft/profile/<uuid>`, `/textures/<uuid>`, `/textures/<uuid>/cape`, `/MinecraftSkins/<name>.png`, `/MinecraftCloaks/<name>.png`, `/session/minecraft/join` (`204`), `/session/minecraft/hasJoined?username=X` (returns derived `offlineUuid` + `textures` property). `findOfflineSkinByUuid` checks `offline_skins` by direct uuid + offlineUuid(nick) + `offlineUuid(lower(nick))`, `friendSkinResolver` (`PresenceService.lookupFriendSkin`), `networkPeerSkins`, then `SkinDirectory` (`byuuid`), then `ely.by` (`tryElyByForUuid` `elyby.ts` `skins/<nick>.png` `301→http://ely.by/storage/...` + `cloaks` + `textures/<nick>` for variant). Legacy `serveLegacyTexture` tries local → friend → `ely.by` → `s3.amazonaws`. `presence.ts:387` `selfSkin()` broadcasts own skin base64 (≤40KB, HD downscaled to 64×64 via `png-utils.ts` `resizePng`) via multicast+direct broadcast `presence.ts:499`.

**Network:** `services/network.ts` Radmin-like TCP mesh, `handlers/network.ts` `resolveIdentity` (nick/uuid/skin). `PresenceService` `services/presence.ts` multicasts `RawPacket` `{slime:1,nick,uuid,state,game,loader,mods,server,port,skin,skinVariant,ts}` every 3s, `port` from `logs/latest.log` `parseLogState` (`presence.ts:108`). `Network` also handles `hostInfo/peerInfo/chat/gamePort`.

**Other services:** `services/database.ts`, `settings-store.ts`, `download-manager.ts`, `recorder.ts` (`ffmpeg` via `tools/ffmpeg`), `world-backups.ts` (`archiver` zip), `dedicated-server.ts` (`UPnP` via `nat.ts`), `discord-rpc.ts` (IPC to `discord-ipc-N`), `skin-directory.ts` (optional `PUT /api/skins/<nick>` + `GET /byuuid` with `remote_skins` cache `24h`), `elyby.ts` (central fallback).

**Build:** `package.json` `version` `1.18.0`, `vite build` → `dist/` + `dist-electron/`, `electron-builder --win` → `release/SlimeLauncher Setup 1.18.0.exe` (nsis + portable).

**i18n:** `src/lib/i18n.ts` `translations: en/ru`, `t(key,params)`, `setLanguage` called from `settingsStore`. Keys used via `t()` in React (`SkinsPage.tsx:310` `t('skins.help_title')`).

**Known quirks:** `onlineMode` offline UUID CaSe-sensitive (`AuthMe` kick), `ely.by` is case-insensitive, `better-sqlite3` needs rebuild per arch, `VirtualBox 192.168.56.x` filtered.

