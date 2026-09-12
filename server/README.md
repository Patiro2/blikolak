# Serwer relay (bankomat-clicker)

Czysty przekaznik WebSocket dla trybu realtime. NIE symuluje gry - tylko
przyjmuje snapshoty/zdarzenia od karty wlasciciela (hosta) i rozsyla je bez
zmian do podlaczonych widzow. Gra dziala normalnie bez tego serwera (patrz
`URL_RELAYA` w `src/realtime.js`) - to jest opcjonalne przyspieszenie
synchronizacji, nie wymagana zaleznosc.

## Uruchomienie lokalne

```bash
cd server
npm install
HOST_TOKEN=twoje-haslo node server.js
```

Domyslny port to `8787`. Sprawdzenie zdrowia:

```bash
curl http://localhost:8787/zdrowie
```

## Zmienne srodowiskowe

| Zmienna | Domyslnie | Opis |
|---|---|---|
| `PORT` | `8787` | Port HTTP + WebSocket (jeden port, ten sam serwer) |
| `HOST_TOKEN` | *(brak)* | Haslo wymagane do polaczenia w roli `host`. Bez niego rola hosta jest calkowicie zablokowana - nikt nie moze wstrzyknac stanu. |
| `PLIK_STANU` | `./ostatni-stan.json` | Sciezka pliku, w ktorym serwer trzyma ostatni snapshot (zapis co 30 s + przy zamknieciu), zeby restart nie gubil postepu |

## Protokol

Polaczenie: `wss://adres-serwera?rola=host&token=...` albo `wss://adres-serwera?rola=widz`.

- Host wysyla `{typ:'snapshot', dane:{...}}` i `{typ:'zdarzenie', nazwa, dane}`.
- Serwer przekazuje te same ramki widzom bez zmian.
- Nowo podlaczony widz dostaje natychmiast `{typ:'snapshot', dane}` (albo
  `{typ:'brak-hosta'}`, gdy hosta jeszcze nie bylo).
- Zmiana dostepnosci hosta: `{typ:'host-online'}` / `{typ:'host-offline'}`.
- Tylko jeden host naraz - nowy host z poprawnym tokenem przejmuje role,
  staremu leci `{typ:'zastapiony'}` i zamkniecie polaczenia.
- Wiadomosci od widza sa w calosci ignorowane (widz nie moze wstrzyknac stanu).

## Wdrozenie na Render (darmowy web service)

1. Wrzuc katalog `server/` jako osobne repo albo wskaz Renderowi podkatalog
   `server` w istniejacym repo (Root Directory: `server`).
2. Typ uslugi: **Web Service**, srodowisko: Node.
3. Build command: `npm install`. Start command: `node server.js`.
4. W zakladce Environment ustaw `HOST_TOKEN` (i opcjonalnie `PLIK_STANU`,
   `PORT` - Render sam narzuca `PORT`, wiec zwykle nie trzeba go ustawiac).
5. Adres uslugi (np. `wss://twoja-nazwa.onrender.com`) wklej do
   `URL_RELAYA` w `src/realtime.js`.

**Uwaga:** darmowy plan Renderu usypia usluge po ok. 15 minutach bezczynnosci
i pierwsze polaczenie po usypianiu trwa kilkanascie-kilkadziesiat sekund
(zimny start). Endpoint `GET /zdrowie` nadaje sie do zewnetrznego "budzika"
(np. cron/uptime-monitor odpytujacy go co kilka minut), zeby usluga nie
usypiala w trakcie streamu.

## Wdrozenie na VPS (systemd)

```ini
# /etc/systemd/system/bankomat-relay.service
[Unit]
Description=bankomat-clicker relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/sciezka/do/server
Environment=HOST_TOKEN=twoje-haslo
Environment=PORT=8787
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bankomat-relay
sudo systemctl status bankomat-relay
```

Postaw przed tym reverse proxy (nginx/caddy) z TLS, zeby adres byl `wss://`
(przegladarki na stronie `https://` nie polacza sie z `ws://`).

### Alternatywa: pm2

```bash
cd server
npm install
npm install -g pm2
HOST_TOKEN=twoje-haslo pm2 start server.js --name bankomat-relay
pm2 save
pm2 startup   # skonfiguruje autostart po restarcie maszyny
```
