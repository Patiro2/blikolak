// Serwer relay dla bankomat-clicker.
//
// To jest CZYSTY przekaznik, NIE symuluje gry: karta wlasciciela (host) jest
// jedynym zrodlem prawdy o stanie i wysyla snapshoty/zdarzenia, serwer
// rozglasza je bez zmian do wszystkich podlaczonych widzow. Widz nie moze
// wstrzyknac zadnego stanu - jego wiadomosci sa ignorowane.
//
// Zmienne srodowiskowe:
//   PORT        - port HTTP/WS (domyslnie 8787)
//   HOST_TOKEN  - haslo wymagane do polaczenia w roli hosta (bez niego rola
//                 host jest calkowicie zablokowana - nikt nie moze zostac hostem)
//   PLIK_STANU  - sciezka pliku, w ktorym trzymany jest ostatni snapshot
//                 (domyslnie ./ostatni-stan.json obok tego pliku)
//
// Protokol (JSON, jedna ramka = jedna wiadomosc WS):
//   host -> serwer:   {typ:'snapshot', dane:{...}}
//                      {typ:'zdarzenie', nazwa:'...', dane:{...}}
//   serwer -> widz:    te same ramki, przekazane bez zmian
//   serwer -> nowy widz (od razu po polaczeniu):
//                      {typ:'snapshot', dane:{...}} albo {typ:'brak-hosta'}
//   serwer -> wszyscy: {typ:'host-online'} / {typ:'host-offline'} przy zmianie
//   serwer -> stary host przy przejeciu roli: {typ:'zastapiony'}

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 8787;
const HOST_TOKEN = process.env.HOST_TOKEN || '';
const PLIK_STANU = process.env.PLIK_STANU || path.join(__dirname, 'ostatni-stan.json');

const LIMIT_RAMKI_BAJTOW = 256 * 1024; // 256 KB
const LIMIT_RAMEK_NA_SEKUNDE = 60;
const INTERWAL_ZAPISU_MS = 30000;
const INTERWAL_HEARTBEAT_MS = 30000;

// --- Stan w pamieci -------------------------------------------------------

let ostatniSnapshot = null; // {dane: {...}, czas: <ms epoch>}
let hostWs = null;
const widzowie = new Set();

function wczytajStanZPliku() {
  try {
    const tresc = fs.readFileSync(PLIK_STANU, 'utf8');
    const zapisany = JSON.parse(tresc);
    if (zapisany && typeof zapisany === 'object' && zapisany.dane) {
      ostatniSnapshot = { dane: zapisany.dane, czas: zapisany.czas || Date.now() };
      log(`Wczytano zapisany stan z ${PLIK_STANU} (wiek ${Date.now() - ostatniSnapshot.czas} ms)`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log(`Nie udalo sie wczytac ${PLIK_STANU}: ${err.message}`);
    }
  }
}

function zapiszStanDoPliku() {
  if (!ostatniSnapshot) return;
  try {
    fs.writeFileSync(PLIK_STANU, JSON.stringify(ostatniSnapshot), 'utf8');
  } catch (err) {
    log(`Nie udalo sie zapisac ${PLIK_STANU}: ${err.message}`);
  }
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

/** Porownanie stalo-czasowe tokenu (wzorowane na api/_kv.js czyAdmin). */
function tokenPoprawny(podany) {
  if (!HOST_TOKEN) return false;
  if (typeof podany !== 'string' || podany.length !== HOST_TOKEN.length) return false;
  let roznica = 0;
  for (let i = 0; i < HOST_TOKEN.length; i++) {
    roznica |= HOST_TOKEN.charCodeAt(i) ^ podany.charCodeAt(i);
  }
  return roznica === 0;
}

function wyslij(ws, obiekt) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(obiekt));
  } catch (err) {
    log('Blad wysylki ramki:', err.message);
  }
}

function rozgloszWszystkim(obiekt) {
  if (hostWs) wyslij(hostWs, obiekt);
  for (const w of widzowie) wyslij(w, obiekt);
}

function rozgloszWidzom(obiekt) {
  for (const w of widzowie) wyslij(w, obiekt);
}

// --- HTTP: GET /zdrowie ----------------------------------------------------

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/zdrowie') {
    const cialo = JSON.stringify({
      ok: true,
      host: hostWs !== null,
      widzow: widzowie.size,
      wiekSnapshotuMs: ostatniSnapshot ? Date.now() - ostatniSnapshot.czas : null,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(cialo);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const rola = url.searchParams.get('rola') === 'host' ? 'host' : 'widz';
  const token = url.searchParams.get('token') || '';

  if (rola === 'host') {
    if (!tokenPoprawny(token)) {
      log('Odrzucono polaczenie hosta - zly token');
      // Kod 4001 nie przechodzi przez proxy hostingow (Render zamienia go na
      // 1006), wiec klient nie odroznilby zlego hasla od awarii sieci i
      // ponawialby w nieskonczonosc. Wysylamy wiec najpierw zwykla ramke -
      // ta przechodzi zawsze - i dopiero potem zamykamy polaczenie.
      wyslij(ws, { typ: 'zly-token' });
      setTimeout(() => {
        try {
          ws.close(4001, 'zly token');
        } catch (_) {}
      }, 50);
      return;
    }
    if (hostWs) {
      log('Nowy host przejmuje role - stary rozlaczany');
      wyslij(hostWs, { typ: 'zastapiony' });
      hostWs.close(4002, 'zastapiony przez nowego hosta');
    }
    hostWs = ws;
    ws._rola = 'host';
    ws._ramkiOkno = { poczatek: Date.now(), licznik: 0 };
    log('Host polaczony');
    rozgloszWszystkim({ typ: 'host-online' });
  } else {
    ws._rola = 'widz';
    widzowie.add(ws);
    log(`Widz polaczony (lacznie: ${widzowie.size})`);
    // Natychmiastowy stan dla nowo podlaczonego widza.
    if (ostatniSnapshot) {
      wyslij(ws, { typ: 'snapshot', dane: ostatniSnapshot.dane });
    } else {
      wyslij(ws, { typ: 'brak-hosta' });
    }
    if (hostWs) wyslij(ws, { typ: 'host-online' });
  }

  ws._alive = true;
  ws.on('pong', () => {
    ws._alive = true;
  });

  ws.on('message', (raw) => {
    if (ws._rola !== 'host') {
      // Widz nie moze wstrzykiwac zadnego stanu - ramki od widza sa ignorowane.
      return;
    }
    if (raw.length > LIMIT_RAMKI_BAJTOW) {
      log(`Ramka hosta odrzucona - za duza (${raw.length} B)`);
      return;
    }

    // Limit tempa: max LIMIT_RAMEK_NA_SEKUNDE ramek/s od hosta.
    const teraz = Date.now();
    if (teraz - ws._ramkiOkno.poczatek >= 1000) {
      ws._ramkiOkno.poczatek = teraz;
      ws._ramkiOkno.licznik = 0;
    }
    ws._ramkiOkno.licznik += 1;
    if (ws._ramkiOkno.licznik > LIMIT_RAMEK_NA_SEKUNDE) {
      return;
    }

    let wiadomosc;
    try {
      wiadomosc = JSON.parse(raw.toString());
    } catch (err) {
      log('Blad parsowania ramki hosta:', err.message);
      return;
    }
    if (!wiadomosc || typeof wiadomosc !== 'object') return;

    if (wiadomosc.typ === 'snapshot') {
      ostatniSnapshot = { dane: wiadomosc.dane, czas: Date.now() };
      rozgloszWidzom({ typ: 'snapshot', dane: wiadomosc.dane });
    } else if (wiadomosc.typ === 'zdarzenie') {
      rozgloszWidzom({ typ: 'zdarzenie', nazwa: wiadomosc.nazwa, dane: wiadomosc.dane });
    }
    // Inne typy ramek od hosta sa ignorowane.
  });

  ws.on('close', () => {
    if (ws._rola === 'host') {
      if (hostWs === ws) {
        hostWs = null;
        log('Host rozlaczony');
        rozgloszWszystkim({ typ: 'host-offline' });
      }
    } else {
      widzowie.delete(ws);
      log(`Widz rozlaczony (lacznie: ${widzowie.size})`);
    }
  });

  ws.on('error', (err) => {
    log('Blad polaczenia WS:', err.message);
  });
});

// --- Heartbeat: zrywanie martwych polaczen ---------------------------------

const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._alive === false) {
      log(`Zrywam martwe polaczenie (${ws._rola || '?'})`);
      ws.terminate();
      continue;
    }
    ws._alive = false;
    try {
      ws.ping();
    } catch (_) {
      // ignorujemy - close/error i tak posprzataja
    }
  }
}, INTERWAL_HEARTBEAT_MS);

// --- Okresowy zapis stanu na dysk -------------------------------------------

const zapisTimer = setInterval(zapiszStanDoPliku, INTERWAL_ZAPISU_MS);

// --- Start / zamkniecie ----------------------------------------------------

wczytajStanZPliku();

if (!HOST_TOKEN) {
  log('UWAGA: zmienna HOST_TOKEN nie jest ustawiona - rola hosta jest calkowicie zablokowana.');
}

httpServer.listen(PORT, () => {
  log(`Serwer relay nasluchuje na porcie ${PORT} (plik stanu: ${PLIK_STANU})`);
});

function zamknij(sygnal) {
  log(`Otrzymano ${sygnal} - zapisuje stan i koncze`);
  clearInterval(heartbeatTimer);
  clearInterval(zapisTimer);
  zapiszStanDoPliku();
  wss.close(() => {
    httpServer.close(() => process.exit(0));
  });
  // Awaryjne wyjscie, gdyby zamkniecie polaczen sie zawiesilo.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => zamknij('SIGTERM'));
process.on('SIGINT', () => zamknij('SIGINT'));
