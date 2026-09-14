// Panel diagnostyczny.
// - Zalogowany (remote.czyAdmin(), lokalnie zawsze): pelny panel - FPS,
//   najgorsza klatka, klatki > 100 ms (petla gry obcina delta do 0.1 s, wiec
//   takie klatki realnie spowalniaja ruch postaci), draw calle, opoznienie
//   Kicka (created_at wiadomosci -> odebranie w karcie), czas od komendy ruchu
//   do ruszenia postaci, ping serwera.
// - Widz: jedna linia - FPS i ping serwera.
// Ping to RTT zapytania do serwera, z ktorego serwowana jest gra (przekaznik
// realtime nie ma pingu w protokole, a protokolu nie ruszamy).
// Nie rusza kick.js ani workers.js - owija ich callbacki z zewnatrz.
// F9 chowa/pokazuje panel i ZAPAMIETUJE to w przegladarce (karta prowadzaca
// stream moze go schowac raz na stale). ?diag=0 w URL wylacza calkiem.

const ROZMIAR_PROBKI = 20;
const KLUCZ_UKRYCIA = 'bankomat-clicker-diag-ukryty';

function dodaj(tab, v) {
  tab.push(v);
  if (tab.length > ROZMIAR_PROBKI) tab.shift();
}

function srednia(tab) {
  return tab.length ? Math.round(tab.reduce((a, b) => a + b, 0) / tab.length) : null;
}

function opis(tab) {
  if (tab.length === 0) return '-';
  return `ost ${Math.round(tab[tab.length - 1])}  sr ${srednia(tab)}  max ${Math.round(Math.max(...tab))} ms`;
}

export function uruchomDiagnostyke({ renderer, kickChat, workerManager, realtime, remote }) {
  if (new URLSearchParams(location.search).get('diag') === '0') return;

  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99999;margin:0;padding:6px 10px;'
    + 'background:rgba(0,0,0,.72);color:#53fc18;font:12px/1.4 ui-monospace,Consolas,monospace;'
    + 'pointer-events:none;white-space:pre;border-radius:6px';
  try {
    el.hidden = localStorage.getItem(KLUCZ_UKRYCIA) === '1';
  } catch (_) {}
  document.body.appendChild(el);
  addEventListener('keydown', (e) => {
    if (e.key !== 'F9') return;
    el.hidden = !el.hidden;
    try {
      localStorage.setItem(KLUCZ_UKRYCIA, el.hidden ? '1' : '0');
    } catch (_) {}
  });

  const opoznieniaKick = [];
  const reakcjeRuchu = [];
  const pingi = [];
  const oczekujace = []; // komendy ruchu czekajace na pierwsza zmiane pozycji/obrotu postaci
  let wiadomosci = 0;

  // Skoki opoznienia Kicka (> 3 s) zapisywane Z KONTEKSTEM, zeby przy
  // nastepnym wystapieniu bylo wiadomo, co je spowodowalo: dluga cisza na
  // gniezdzie i paczka ramek naraz = zastoj polaczenia, duzy lag petli zdarzen
  // = zablokowana strona, karta w tle, albo nic z tego = opoznienie po stronie Kicka.
  const skoki = [];
  let skokowLacznie = 0;
  let ostRamka = performance.now();
  let paczkaStart = 0;
  let paczka = 0;
  let lagi = []; // przestoje petli zdarzen > 150 ms z ostatnich 20 s
  function podepnijGniazdo() {
    const ws = kickChat.ws;
    if (!ws || ws.__diag) return;
    ws.__diag = true;
    // Ten sluchacz odpala sie PO onmessage z kick.js, wiec w wrapperze onMessage
    // nizej ostRamka to jeszcze czas POPRZEDNIEJ ramki - dokladnie o to chodzi.
    ws.addEventListener('message', () => {
      const t = performance.now();
      if (t - paczkaStart < 50) paczka++;
      else {
        paczka = 1;
        paczkaStart = t;
      }
      ostRamka = t;
    });
  }
  podepnijGniazdo();
  setInterval(podepnijGniazdo, 2000); // kick.js tworzy nowe gniazdo przy kazdym ponownym polaczeniu
  let oczekiwanyTik = performance.now() + 100;
  setInterval(() => {
    const t = performance.now();
    const lag = t - oczekiwanyTik;
    oczekiwanyTik = t + 100;
    if (lag > 150) lagi.push({ t, lag });
    lagi = lagi.filter((x) => t - x.t < 20000);
  }, 100);

  function przyczynaSkoku(s) {
    if (s.wTle) return 'karta w tle';
    if (s.lag > s.op / 2) return 'strona zablokowana';
    if (s.cisza > s.op - 2000 || s.paczka > 3) return 'zastoj polaczenia z Kickiem';
    return 'opoznienie po stronie Kicka';
  }

  // Opoznienie Kicka: roznica zegara serwera Kick i tej karty - zawiera tez
  // ewentualne rozjechanie zegarow, wiec to gorna granica, nie dokladny ping.
  const oryginalOnMessage = kickChat.onMessage;
  kickChat.onMessage = (m) => {
    wiadomosci++;
    const ts = Date.parse(m && (m.created_at || m.createdAt || m.timestamp));
    if (!Number.isNaN(ts)) {
      const op = Date.now() - ts;
      dodaj(opoznieniaKick, op);
      if (op > 3000) {
        const t = performance.now();
        const s = {
          op,
          cisza: t - ostRamka,
          paczka: t - paczkaStart < 50 ? paczka + 1 : 1,
          lag: lagi.reduce((max, x) => Math.max(max, x.lag), 0),
          wTle: document.hidden,
        };
        skokowLacznie++;
        dodaj(skoki, s);
        console.warn(`[diag] Skok opoznienia Kicka ${Math.round(op)} ms - ${przyczynaSkoku(s)}`, s);
      }
    }
    return oryginalOnMessage.call(kickChat, m);
  };

  const oryginalQueue = workerManager.queueMoves.bind(workerManager);
  workerManager.queueMoves = (slot, dirs) => {
    const e = workerManager.getWorkerType(slot);
    if (e && e.obj) {
      oczekujace.push({ slot, t: performance.now(), x: e.obj.position.x, z: e.obj.position.z, ry: e.obj.rotation.y });
    }
    return oryginalQueue(slot, dirs);
  };

  // Draw calle sumowane przez wszystkie render() w klatce (cienie, composer).
  renderer.info.autoReset = false;

  let klatki = 0;
  let najgorsza = 0;
  let wolneKlatki = 0;
  let fps = 0;
  let drawCalls = 0;
  let trojkaty = 0;
  let ost = performance.now();
  let okno = ost;

  function klatka(teraz) {
    const dt = teraz - ost;
    ost = teraz;
    klatki++;
    if (dt > najgorsza) najgorsza = dt;
    if (dt > 100) wolneKlatki++;

    drawCalls = renderer.info.render.calls;
    trojkaty = renderer.info.render.triangles;
    renderer.info.reset();

    // Pierwsza klatka, w ktorej postac drgnela (krok albo obrot w miejscu).
    for (let i = oczekujace.length - 1; i >= 0; i--) {
      const o = oczekujace[i];
      const e = workerManager.getWorkerType(o.slot);
      const ruszyla = e && e.obj && (Math.abs(e.obj.position.x - o.x) > 0.005
        || Math.abs(e.obj.position.z - o.z) > 0.005 || Math.abs(e.obj.rotation.y - o.ry) > 0.005);
      if (ruszyla) {
        dodaj(reakcjeRuchu, teraz - o.t);
        oczekujace.splice(i, 1);
      } else if (!e || teraz - o.t > 10000) {
        oczekujace.splice(i, 1);
      }
    }

    if (teraz - okno >= 1000) {
      fps = Math.round((klatki * 1000) / (teraz - okno));
      klatki = 0;
      okno = teraz;
    }
    requestAnimationFrame(klatka);
  }
  requestAnimationFrame(klatka);

  async function zmierzPing() {
    const t0 = performance.now();
    try {
      await fetch(`style.css?diag=${Date.now()}`, { cache: 'no-store' });
      dodaj(pingi, performance.now() - t0);
    } catch (_) {}
  }
  zmierzPing();
  setInterval(zmierzPing, 5000);

  let gpu = '?';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)).replace(/^ANGLE \(|\)$/g, '').slice(0, 48);
  } catch (_) {}

  setInterval(() => {
    if (el.hidden) return;
    const ping = pingi.length ? `${Math.round(pingi[pingi.length - 1])} ms` : '-';
    if (!(remote && remote.czyAdmin())) {
      el.textContent = `FPS ${fps}  |  ping ${ping}`;
      najgorsza = 0;
      return;
    }
    const przekaznik = realtime && typeof realtime.czyPolaczony === 'function'
      ? (realtime.czyPolaczony() ? 'polaczony' : 'rozlaczony / wylaczony lokalnie')
      : '-';
    el.textContent = [
      `FPS              ${fps}${document.hidden ? '  (karta w tle!)' : ''}`,
      `najgorsza klatka ${Math.round(najgorsza)} ms`,
      `klatki >100 ms   ${wolneKlatki}  (spowalniaja ruch)`,
      `draw calle       ${drawCalls}   trojkaty ${Math.round(trojkaty / 1000)} tys.`,
      `Kick -> karta    ${opis(opoznieniaKick)}`,
      `skoki Kick >3 s  ${skokowLacznie === 0 ? 'brak' : (() => {
        const s = skoki[skoki.length - 1];
        return `${skokowLacznie}  ost ${Math.round(s.op)} ms: ${przyczynaSkoku(s)} `
          + `(cisza ${(s.cisza / 1000).toFixed(1)} s, paczka ${s.paczka}, lag ${Math.round(s.lag)} ms)`;
      })()}`,
      `komenda -> ruch  ${opis(reakcjeRuchu)}`,
      `ping serwera     ${opis(pingi)}`,
      `wiadomosci       ${wiadomosci}   postacie ${workerManager.entries.length}`,
      `przekaznik       ${przekaznik}`,
      `GPU              ${gpu}   pr ${renderer.getPixelRatio()}`,
      'F9 ukryj (zapamietane)  |  ?diag=0 wylacz',
    ].join('\n');
    najgorsza = 0;
  }, 500);
}
