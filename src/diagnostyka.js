// Panel diagnostyczny - TYLKO dla wersji testowych (gałęzie nocne/calosc*).
// Pokazuje: FPS, najgorsza klatke, klatki > 100 ms (petla gry obcina delta do
// 0.1 s, wiec takie klatki realnie spowalniaja ruch postaci), draw calle,
// opoznienie Kicka (created_at wiadomosci -> odebranie w karcie), czas od
// odebrania komendy ruchu do ruszenia postaci oraz RTT lokalnego serwera.
// Nie rusza kick.js ani workers.js - owija ich callbacki z zewnatrz.
// Wylacznik: ?diag=0 w URL. Klawisz F9 chowa/pokazuje panel.

const ROZMIAR_PROBKI = 20;

function dodaj(tab, v) {
  tab.push(v);
  if (tab.length > ROZMIAR_PROBKI) tab.shift();
}

function opis(tab) {
  if (tab.length === 0) return '-';
  const posort = [...tab].sort((a, b) => a - b);
  const sr = tab.reduce((a, b) => a + b, 0) / tab.length;
  return `ost ${Math.round(tab[tab.length - 1])}  sr ${Math.round(sr)}  max ${Math.round(posort[posort.length - 1])} ms`;
}

export function uruchomDiagnostyke({ renderer, kickChat, workerManager, realtime }) {
  if (new URLSearchParams(location.search).get('diag') === '0') return;

  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99999;margin:0;padding:8px 10px;'
    + 'background:rgba(0,0,0,.78);color:#53fc18;font:12px/1.4 ui-monospace,Consolas,monospace;'
    + 'pointer-events:none;white-space:pre;border-radius:6px';
  document.body.appendChild(el);
  addEventListener('keydown', (e) => {
    if (e.key === 'F9') el.hidden = !el.hidden;
  });

  const opoznieniaKick = [];
  const reakcjeRuchu = [];
  const rttSerwera = [];
  const oczekujace = []; // komendy ruchu czekajace na pierwsza zmiane pozycji/obrotu postaci
  let wiadomosci = 0;

  // Opoznienie Kicka: roznica zegara serwera Kick i tej karty - zawiera tez
  // ewentualne rozjechanie zegarow, wiec to gorna granica, nie dokladny ping.
  const oryginalOnMessage = kickChat.onMessage;
  kickChat.onMessage = (m) => {
    wiadomosci++;
    const ts = Date.parse(m && (m.created_at || m.createdAt || m.timestamp));
    if (!Number.isNaN(ts)) dodaj(opoznieniaKick, Date.now() - ts);
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

  // RTT lokalnego serwera (maly plik, bez cache).
  async function zmierzSerwer() {
    const t0 = performance.now();
    try {
      await fetch(`style.css?diag=${Date.now()}`, { cache: 'no-store' });
      dodaj(rttSerwera, performance.now() - t0);
    } catch (_) {}
  }
  zmierzSerwer();
  setInterval(zmierzSerwer, 5000);

  let gpu = '?';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)).replace(/^ANGLE \(|\)$/g, '').slice(0, 48);
  } catch (_) {}

  setInterval(() => {
    const przekaznik = realtime && typeof realtime.czyPolaczony === 'function'
      ? (realtime.czyPolaczony() ? 'polaczony' : 'rozlaczony / wylaczony lokalnie')
      : '-';
    el.textContent = [
      `FPS              ${fps}${document.hidden ? '  (karta w tle!)' : ''}`,
      `najgorsza klatka ${Math.round(najgorsza)} ms`,
      `klatki >100 ms   ${wolneKlatki}  (spowalniaja ruch)`,
      `draw calle       ${drawCalls}   trojkaty ${Math.round(trojkaty / 1000)} tys.`,
      `Kick -> karta    ${opis(opoznieniaKick)}`,
      `komenda -> ruch  ${opis(reakcjeRuchu)}`,
      `serwer RTT       ${opis(rttSerwera)}`,
      `wiadomosci       ${wiadomosci}   postacie ${workerManager.entries.length}`,
      `przekaznik       ${przekaznik}`,
      `GPU              ${gpu}   pr ${renderer.getPixelRatio()}`,
      'F9 ukryj  |  ?diag=0 wylacz',
    ].join('\n');
    najgorsza = 0;
  }, 500);
}
