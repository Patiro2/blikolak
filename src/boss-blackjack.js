import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { strumien, tasuj } from './rng.js';
import { showBossNotification } from './ui.js';
import { audio } from './audio.js';

// Mechanika trzeciego bossa (tier 3 bankomatu) - Kristofer, "KROL BLACKJACKA".
// Trzymana w OSOBNYM pliku (patrz CLAUDE.md w bankomat-clicker/ i wzorzec
// src/boss-kowal.js), zeby nie dotykac zweryfikowanej logiki bossow 1 i 2.
// BossManager tworzy instancje tej klasy w start() (gdy def.mechanika ===
// 'blackjack') i deleguje do niej: start walki, update() w CUTSCENE/FIGHT,
// onChatMessage NIE jest uzywany tutaj (decyzje graczy ida przez POZYCJE
// awatarow na siatce, nie przez czat) - HP, FSM (IDLE/CUTSCENE/FIGHT/VICTORY),
// nakladki DOM i kamera zostaja w BossManager.

// ================= TALIA I WARTOSCI KART =================

const RANKI = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const KOLORY_KART = ['♠', '♥', '♦', '♣'];
/** 52 kody kart, np. "A♠", "10♦", "K♣". */
const TALIA = [];
for (const kolor of KOLORY_KART) {
  for (const rank of RANKI) TALIA.push(rank + kolor);
}

/** Wartosc pojedynczej karty - as liczony jako 11 (korekta w sumujReke). */
function wartoscKarty(kod) {
  const rank = kod.slice(0, -1);
  if (rank === 'A') return 11;
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return Number(rank);
}

/** Suma reki - as = 1 lub 11, tak by wynik byl jak najwyzszy, ale <=21. */
function sumujReke(karty) {
  let suma = 0;
  let asy = 0;
  for (const k of karty) {
    suma += wartoscKarty(k);
    if (k.slice(0, -1) === 'A') asy += 1;
  }
  while (suma > 21 && asy > 0) {
    suma -= 10;
    asy -= 1;
  }
  return suma;
}

// ================= STALE MECHANIKI =================

const CZAS_WYBORU = 15.0; // sekund na kazda decyzje DOBIERZ/PASUJ
const REMISY_DO_AUTO_PASU = 3;
const KARA_UDZIAL = 0.10; // 10% POCZATKOWEJ puli, zamrozone na cala walke
const DMG_ZA_WYGRANA = 34; // 100 -> 66 -> 32 -> 0 po 3 wygranych (boss.damage)
const CZAS_ROZSTRZYGNIECIA = 3.4; // sekund pokazania wyniku przed nowym rozdaniem
const ODSTEP_DOBIERANIA_BOSSA = 0.9; // sekund miedzy kolejnymi dobraniami bossa (<17)

// Punkty czasowe rozdania (sekundy od poczatku fazy ROZDANIE) - boss, boss,
// gracze, gracze, DOKLADNIE w tej kolejnosci (wymaganie zadania).
const KROKI_ROZDANIA = [0.6, 1.2, 1.9, 2.5];
const KONIEC_ROZDANIA = 3.0;

// Wysokosc pracownika w jednostkach swiata - ta sama zmierzona wartosc co w
// boss-kowal.js (character-employee.glb). Kristofer ma byc DOKLADNIE 2x
// wyzszy - patrz build() nizej.
const WORKER_HEIGHT = 0.7233532667160034;

// Wejscie na arene: boss idzie z tylu sceny do neutralnej kolumny x=0.
const SPAWN_POS = new THREE.Vector3(0, 0, -4.5);
const FINAL_POS = new THREE.Vector3(0, 0, -2.0);
const CZAS_WEJSCIA = 3.2; // sekund marszu

// Pozycje 3D kart - reka bossa nad/przy bossem, reka graczy blisko kamery
// przed bankomatem (bankomat stoi w (0,0,0)).
const BOSS_KARTY_ORIGIN = new THREE.Vector3(-0.55, 1.85, -2.0);
const GRACZE_KARTY_ORIGIN = new THREE.Vector3(-0.55, 0.55, 1.35);
const ODSTEP_KART = 0.32;
const ROZMIAR_KARTY = [0.26, 0.37];

// Znaczniki polfok DOBIERZ/PASUJ na siatce areny (y=0.06 - patrz zadanie,
// poziomy 0.025/0.035/0.042/0.048/0.052/0.056 sa juz zajete przez inne fx).
const GLOW_Y = 0.06;

/** Klucz strumienia dla talii N-tego rozdania biezacej walki. */
function kluczTalii(seedGry, idWalki, numerRozdania) {
  return `${seedGry}:bj-talia:${idWalki}:${numerRozdania}`;
}

// ================= TEKSTURY KART (canvas, cache) =================

const cacheTeksturKart = new Map();
const SZER_KARTY_PX = 220;
const WYS_KARTY_PX = 310;

/** Rysuje jedna karte (albo rewers dla kod==='BACK') na canvasie i cache'uje. */
function zaladujTeksturaKarty(kod, renderer) {
  if (cacheTeksturKart.has(kod)) return cacheTeksturKart.get(kod);

  const canvas = document.createElement('canvas');
  canvas.width = SZER_KARTY_PX;
  canvas.height = WYS_KARTY_PX;
  const ctx = canvas.getContext('2d');
  const r = 22;

  function zaokraglonyProstokat(x, y, w, h, rad) {
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  if (kod === 'BACK') {
    zaokraglonyProstokat(4, 4, SZER_KARTY_PX - 8, WYS_KARTY_PX - 8, r);
    ctx.fillStyle = '#0d1f4a';
    ctx.fill();
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#f2c94c';
    ctx.stroke();
    ctx.strokeStyle = 'rgba(242, 201, 76, 0.55)';
    ctx.lineWidth = 4;
    for (let i = -6; i <= 6; i++) {
      ctx.beginPath();
      ctx.moveTo(SZER_KARTY_PX / 2 + i * 20, 20);
      ctx.lineTo(SZER_KARTY_PX / 2 + i * 20 + 60, WYS_KARTY_PX - 20);
      ctx.stroke();
    }
    ctx.fillStyle = '#f2c94c';
    ctx.font = 'bold 40px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('K', SZER_KARTY_PX / 2, WYS_KARTY_PX / 2);
  } else {
    const rank = kod.slice(0, -1);
    const kolor = kod.slice(-1);
    const czerwona = kolor === '♥' || kolor === '♦';
    zaokraglonyProstokat(4, 4, SZER_KARTY_PX - 8, WYS_KARTY_PX - 8, r);
    ctx.fillStyle = '#fbfbf6';
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#1a1a1a';
    ctx.stroke();

    ctx.fillStyle = czerwona ? '#d21f2f' : '#161616';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = 'bold 44px sans-serif';
    ctx.fillText(rank, 16, 10);
    ctx.font = '38px sans-serif';
    ctx.fillText(kolor, 16, 58);

    ctx.save();
    ctx.translate(SZER_KARTY_PX - 16, WYS_KARTY_PX - 10);
    ctx.rotate(Math.PI);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = 'bold 44px sans-serif';
    ctx.fillText(rank, 0, 0);
    ctx.font = '38px sans-serif';
    ctx.fillText(kolor, 0, 48);
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 120px sans-serif';
    ctx.fillText(kolor, SZER_KARTY_PX / 2, WYS_KARTY_PX / 2 + 10);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (renderer && renderer.capabilities && typeof renderer.capabilities.getMaxAnisotropy === 'function') {
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
  texture.needsUpdate = true;
  cacheTeksturKart.set(kod, texture);
  return texture;
}

// ================= TEKSTURA ETYKIETY PODLOGI (DOBIERZ / PASUJ) =================

function zaladujTeksturaEtykietyPodlogi(tekst, tloRgba, kolorTekstu, kolorObrysu) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = tloRgba;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = kolorObrysu;
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, canvas.width - 14, canvas.height - 14);
  ctx.fillStyle = kolorTekstu;
  ctx.font = 'bold 92px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Plane jest polozony plasko (rotation.x = -PI/2, patrz _budujGlowZnaczniki)
  // i widziany z domyslnej kamery (0, 3.2, 5.4) z domyslnym camera.up=(0,1,0).
  // Zmierzone empirycznie NA ZYWO (bezposrednia podmiana tekstury na dzialajacym
  // obiekcie sceny + zrzut z dokladnie tej kamery, patrz zadanie weryfikacyjne):
  // ZWYKLY, NIEOBROCONY rysunek na canvasie czyta sie poprawnie z tej kamery.
  // (wczesniejsze wersje z ctx.rotate(PI) albo lustrem byly efektem mylacych
  // testow z zanieczyszczonym stanem kamery/cache modulu - ten wynik zostal
  // zweryfikowany bezposrednio na dzialajacym obiekcie sceny, bez posrednikow).
  ctx.fillText(tekst, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// ================= PODMIANA KOLORU BLUZY (canvas colormap, flood-fill) =================

// Kolory skory na atlasie assets/arcade/Textures/colormap.png (zmierzone w
// zadaniu wlasciciela) - NIGDY nie przemalowywane.
const SKIN_KOLORY = [
  [230, 174, 135],
  [207, 122, 85],
  [204, 135, 95],
];
const SKIN_TOLERANCJA = 30 * 30 * 3;

function jestKoloremSkory(r, g, b) {
  for (const [sr, sg, sb] of SKIN_KOLORY) {
    const odl = (r - sr) ** 2 + (g - sg) ** 2 + (b - sb) ** 2;
    if (odl < SKIN_TOLERANCJA) return true;
  }
  return false;
}

// Tolerancja "podobienstwa" koloru przy wypelnianiu spojnego obszaru -
// wystarczajaco mala, zeby zatrzymac sie na faktycznej granicy swatcha w
// atlasie (nie przeskoczyc do sasiedniego, innego koloru), ale na tyle
// duza, zeby ogarnac lekkie gradienty/antyaliasing wewnatrz jednego swatcha.
const WYPELNIENIE_TOLERANCJA = 22 * 22 * 3;
const JASNOSZARY_BLUZY = [216, 216, 219];

/**
 * Wypelnia SPOJNY obszar o zblizonym kolorze (4-connected flood fill) na
 * ImageData.data, startujac od piksela (sx,sy). Uzywane zamiast globalnego
 * dopasowania koloru (ktore w tym atlasie okazalo sie bledne - patrz
 * komentarz przy zbierzUvPunktyTorsu nizej): flood fill przemalowuje
 * DOKLADNIE ten kawalek atlasu, ktory faktycznie probkuje bluza/rekawy, bez
 * ryzyka przypadkowego trafienia w inny swatch o tym samym kolorze (np.
 * czarne buty gdzie indziej w atlasie).
 */
function wypelnijSpojnyObszar(data, visited, w, h, sx, sy, nowyKolor) {
  const idx0 = (sy * w + sx) * 4;
  const r0 = data[idx0];
  const g0 = data[idx0 + 1];
  const b0 = data[idx0 + 2];
  const stos = [[sx, sy]];
  const dotkniete = [];
  while (stos.length) {
    const [x, y] = stos.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const p = y * w + x;
    if (visited[p]) continue;
    const idx = p * 4;
    const dr = data[idx] - r0;
    const dg = data[idx + 1] - g0;
    const db = data[idx + 2] - b0;
    if (dr * dr + dg * dg + db * db > WYPELNIENIE_TOLERANCJA) continue;
    visited[p] = 1;
    dotkniete.push(p);
    stos.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  for (const p of dotkniete) {
    const idx = p * 4;
    data[idx] = nowyKolor[0];
    data[idx + 1] = nowyKolor[1];
    data[idx + 2] = nowyKolor[2];
  }
}

/**
 * Zbiera punkty UV wierzcholkow body-mesh nalezacych do TORSU/RAK, z
 * pominieciem NOG. Geometria SkinnedMesh trzyma pozycje w POZIE BIND (T-pose),
 * gdzie nogi i tors+ramiona wychodza jako dwa wyraznie oddzielone zakresy Y
 * (zmierzone empirycznie - histogram Y calego body-mesh ma pusty przedzial
 * [0.276, 0.307] miedzy tymi dwiema grupami) - stad prog 0.29. Bez tego
 * podzialu flood-fill wypelnilby tez np. czarne buty (inny swatch, ale
 * dotykany przez wierzcholki nog).
 */
function zbierzUvPunktyTorsu(bodyMesh) {
  const geo = bodyMesh.geometry;
  const posAttr = geo.attributes.position;
  const uvAttr = geo.attributes.uv;
  const punkty = [];
  const PROG_Y_NOGI = 0.29;
  for (let i = 0; i < posAttr.count; i++) {
    if (posAttr.getY(i) < PROG_Y_NOGI) continue;
    punkty.push({ u: uvAttr.getX(i), v: uvAttr.getY(i) });
  }
  return punkty;
}

/**
 * Wczytuje assets/arcade/Textures/colormap.png jako <img>, kopiuje do canvasu,
 * i flood-fillem przemalowuje NA JASNOSZARO dokladnie te swatche atlasu, ktore
 * faktycznie probkuje torsu/rekawy KONKRETNEGO body-mesh (parametr `uvPunkty` -
 * patrz zbierzUvPunktyTorsu). Zwraca CanvasTexture gotowa do przypisania do
 * SKLONOWANEGO materialu body-mesh. Zwraca Promise (ladowanie obrazka jest
 * async) - NIE cache'owana globalnie (w odroznieniu od poprzedniej wersji),
 * bo wynik zalezy od `uvPunkty` konkretnego modelu.
 */
function zaladujPodmienionaTeksturaBluzy(uvPunkty, renderer) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const w = canvas.width;
      const h = canvas.height;
      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;
      const visited = new Uint8Array(w * h);

      for (const { u, v } of uvPunkty) {
        const x = Math.min(w - 1, Math.max(0, Math.round(u * w)));
        // Canvas ma origin w lewym-gornym rogu, UV w lewym-dolnym - stad odwrocenie V.
        const y = Math.min(h - 1, Math.max(0, Math.round((1 - v) * h)));
        const p = y * w + x;
        if (visited[p]) continue;
        const idx = p * 4;
        if (jestKoloremSkory(data[idx], data[idx + 1], data[idx + 2])) continue;
        wypelnijSpojnyObszar(data, visited, w, h, x, y, JASNOSZARY_BLUZY);
      }
      ctx.putImageData(imgData, 0, 0);

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.NearestFilter;
      if (renderer && renderer.capabilities && typeof renderer.capabilities.getMaxAnisotropy === 'function') {
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      }
      texture.needsUpdate = true;
      resolve(texture);
    };
    img.onerror = () => reject(new Error('Nie udalo sie zaladowac colormap.png dla Kristofera'));
    img.src = 'assets/arcade/Textures/colormap.png';
  });
}

// ================= TEKSTURA OCZU "7" =================

// Male tlo w kolorze skory (zamiast duzego bialego dysku) - tylko na tyle
// duze, zeby zakryc oryginalny (ciemny) otwor oka modelu pod spodem.
function zaladujTeksturaOka() {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgb(230,174,135)';
  ctx.beginPath();
  ctx.arc(48, 48, 40, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3a0a0a';
  ctx.font = '900 64px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('7', 48, 53);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export class BossBlackjack {
  constructor(boss) {
    // Referencja do BossManager - scena, kamera, workerManager, kickChat,
    // economy (seedGry, money), czyNaliczanieDozwolone, _log, damage - patrz
    // boss.js. onGameOver ustawiany z main.js przez boss.setContext.
    this.boss = boss;

    this.model = null;
    this.mixer = null;
    this.currentAction = null;
    this.animations = [];

    this.fazaWejscia = false;
    this._wejscieT = 0;

    // --- FSM rozgrywki (patrz update()/_updateHost()) ---
    this.round = 1; // numer rozdania - CZESC KLUCZA TALII (patrz kluczTalii)
    this.faza = 'ROZDANIE'; // ROZDANIE | WYBOR | TURA_BOSSA | ROZSTRZYGNIECIE | KONIEC_GRY
    this.fazaT = 0;
    this._dealSteps = [false, false, false, false];
    this.bossCount = 0;
    this.playerCount = 0;
    this.hiddenRevealed = false;
    this.decyzjaT = CZAS_WYBORU;
    this.remisCount = 0;
    this._resolveApplied = false;
    this.resolveT = 0;
    this.resultText = '';
    this._bossDrawTimer = 0;

    // Kara zamrozona raz na starcie walki - patrz beginEntrance/startFromSync.
    this.kara = 0;

    this._deckCache = null; // { round, karty }

    // --- Wizualizacja kart (3D sprite'y) ---
    this._spriteBoss = [];
    this._spritePlayer = [];
    this._renderRound = null;
    this._renderBossCount = 0;
    this._renderPlayerCount = 0;
    this._renderHiddenRevealed = false;

    this._glowDobierz = null;
    this._glowPasuj = null;

    this._eyeMeshes = [];
  }

  // ================= BUDOWA MODELU =================

  /** Buduje postac Kristofera (character-male-b) w skali 2x pracownika. */
  build() {
    const boss = this.boss;
    const char = SkeletonUtils.clone(boss.blackjackTemplate);
    this.animations = boss.blackjackAnimations || [];

    const box = new THREE.Box3().setFromObject(char);
    const wysoscNatywna = Math.max(0.0001, box.max.y - box.min.y);
    const skala = (2 * WORKER_HEIGHT) / wysoscNatywna;
    char.scale.setScalar(skala);
    this.skala = skala;
    this.wysokoscNatywna = wysoscNatywna;

    char.traverse((n) => {
      if (n.isMesh) {
        n.castShadow = true;
        n.receiveShadow = true;
      }
    });

    this.model = char;
    this.mixer = new THREE.AnimationMixer(char);
    this.currentAction = null;

    this._ubierzKristofera(char);

    boss.scene.add(char);
    this._budujGlowZnaczniki();
    return char;
  }

  /** Wszystkie dodatki z prymitywow + podmiana koloru bluzy - patrz zadanie. */
  _ubierzKristofera(char) {
    const bodyMesh = char.getObjectByName('body-mesh');
    const headMesh = char.getObjectByName('head-mesh');
    const head = char.getObjectByName('head');
    const torso = char.getObjectByName('torso');
    const armLeft = char.getObjectByName('arm-left');

    // Bluza jasnoszara w miejsce niebiesko/czerwonej - klon materialu TYLKO
    // na body-mesh, zeby head-mesh (i wspoldzielony material pracownikow)
    // zostal nietkniety (patrz zadanie: "Oryginalnego materialu/tekstury
    // wspoldzielonej przez pracownikow NIE modyfikuj").
    if (bodyMesh && bodyMesh.material) {
      const matOryg = bodyMesh.material;
      const mat = matOryg.clone();
      bodyMesh.material = mat;
      // UWAGA (poprawka po weryfikacji): globalne dopasowanie koloru (stara
      // wersja) nigdy nie trafialo w faktyczny swatch torsu - zmierzone
      // empirycznie (probka pikseli pod UV wierzcholkow torsu), ze glowna
      // powierzchnia torsu/rekawow w tym atlasie jest CZARNA (0,0,0), nie
      // niebieska/czerwona, i zaden prog odleglosci RGB od niebieskiego nie
      // mogl jej zlapac. Flood-fill (patrz zaladujPodmienionaTeksturaBluzy)
      // przemalowuje DOKLADNIE swatch(e), ktore faktycznie probkuje TEN
      // model, niezaleznie od tego, jaki to kolor.
      const uvPunktowTorsu = zbierzUvPunktyTorsu(bodyMesh);
      zaladujPodmienionaTeksturaBluzy(uvPunktowTorsu, null).then((tex) => {
        mat.map = tex;
        mat.needsUpdate = true;
      }).catch((err) => {
        console.warn('[boss-blackjack] Nie udalo sie podmienic koloru bluzy:', err);
      });
    }

    if (head) {
      // Srodek/promien glowy w lokalnej przestrzeni kosci 'head' - zmierzone
      // TU I TERAZ (Box3 head-mesh w biezacej chwili budowy, przed
      // jakimkolwiek mixer.update()) i przeliczone przez head.worldToLocal()
      // NA MIEJSCU, zeby uniknac rozjazdu miedzy poza bind (T-pose, w ktorej
      // geometria SkinnedMesh jest zawsze wyrazona) a poza w chwili pomiaru -
      // stary, zahardkodowany zestaw liczb byl kalibrowany w konsoli PO kilku
      // sekundach animacji idle/walk i dawal bledne wyniki (patrz historia
      // commitow tego pliku - wlosy renderowaly sie ~0.5 jednostki nad glowa).
      // WAZNE: promienia NIE liczymy jako "rozmiar w world space" wprost -
      // world-space dlugosc i local-space dlugosc NIE sa tym samym skalarem,
      // gdy lokalna przestrzen kosci ma inna skale niz swiat (a tu ma - char
      // jest skalowany x2 wysokosci pracownika, patrz build()). Poprzednia
      // wersja tego pliku popelniala dokladnie ten blad (promien zmierzony w
      // world space uzyty WPROST jako lokalny offset), przez co wlosy
      // wychodzily ~2x za duze/za wysoko ("czarny beret" z zadania
      // weryfikacyjnego). Poprawka: przeliczamy WSZYSTKIE punkty referencyjne
      // (srodek + 3 punkty na powierzchni) przez head.worldToLocal I DOPIERO
      // W LOKALNEJ przestrzeni liczymy odleglosci/promien.
      head.updateWorldMatrix(true, false);
      const headBox = new THREE.Box3().setFromObject(headMesh);
      const worldCenter = headBox.getCenter(new THREE.Vector3());
      const worldTop = new THREE.Vector3(worldCenter.x, headBox.max.y, worldCenter.z);
      const worldSide = new THREE.Vector3(headBox.max.x, worldCenter.y, worldCenter.z);
      const worldFront = new THREE.Vector3(worldCenter.x, worldCenter.y, headBox.max.z);
      const HEAD_C = head.worldToLocal(worldCenter.clone());
      const localTop = head.worldToLocal(worldTop.clone());
      const localSide = head.worldToLocal(worldSide.clone());
      const localFront = head.worldToLocal(worldFront.clone());
      const HEAD_R = (
        localTop.distanceTo(HEAD_C)
        + localSide.distanceTo(HEAD_C)
        + localFront.distanceTo(HEAD_C)
      ) / 3;

      // Krotko sciete wlosy ("buzz cut") - CIENKA, polprzezroczysta warstwa
      // KONCENTRYCZNA z glowa (ten sam srodek), promien tylko ~3% wiekszy -
      // przylega scisle do czaszki zamiast tworzyc oddzielna bryle/beret.
      // Ograniczona do sfery kata (thetaLength) od bieguna gornego, wiec
      // pokrywa WYLACZNIE czubek/tyl (nie schodzi do linii oczu/czola).
      const wlosy = new THREE.Mesh(
        new THREE.SphereGeometry(HEAD_R * 1.03, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.36),
        new THREE.MeshStandardMaterial({
          color: 0x6b5a44, // ciemny blond/szarobrazowy, NIE czarny
          roughness: 1,
          transparent: true,
          opacity: 0.85,
        }),
      );
      wlosy.position.set(HEAD_C.x, HEAD_C.y, HEAD_C.z);
      wlosy.castShadow = true;
      head.add(wlosy);

      // Zarost - kilkudniowy cien na zuchwie/policzkach/nad warga: mala,
      // splaszczona, polprzezroczysta warstwa CIEMNOSZARA (nie pomaranczowa -
      // poprzednia wersja byla zbyt duza i zbyt ciemna, przez co przez
      // polprzezroczystosc "przebijala" pomaranczowa skora spod spodu i
      // wygladala jak broda). Mala plama, TYLKO dolna-przednia czesc twarzy.
      const zarost = new THREE.Mesh(
        new THREE.SphereGeometry(HEAD_R * 0.34, 16, 12),
        new THREE.MeshStandardMaterial({
          color: 0x4a4a4a,
          roughness: 1,
          transparent: true,
          opacity: 0.42,
        }),
      );
      zarost.scale.set(0.95, 0.5, 0.4);
      zarost.position.set(HEAD_C.x, HEAD_C.y - HEAD_R * 0.58, HEAD_C.z + HEAD_R * 0.82);
      zarost.castShadow = false;
      head.add(zarost);

      // Oczy - dwie male plaszczyzny z tekstura "7" (male tlo w kolorze
      // skory zamiast duzego bialego dysku - patrz zaladujTeksturaOka),
      // wielkosc zblizona do oryginalnych oczu modelu (nie "pol twarzy").
      const teksturaOka = zaladujTeksturaOka();
      const geoOko = new THREE.PlaneGeometry(0.05, 0.05);
      const pozycjeOczu = [
        [HEAD_C.x - HEAD_R * 0.32, HEAD_C.y + HEAD_R * 0.2, HEAD_C.z + HEAD_R * 0.97],
        [HEAD_C.x + HEAD_R * 0.32, HEAD_C.y + HEAD_R * 0.2, HEAD_C.z + HEAD_R * 0.97],
      ];
      for (const [x, y, z] of pozycjeOczu) {
        const oko = new THREE.Mesh(
          geoOko,
          new THREE.MeshBasicMaterial({ map: teksturaOka, transparent: true, depthWrite: false }),
        );
        oko.position.set(x, y, z);
        oko.castShadow = false;
        head.add(oko);
        this._eyeMeshes.push(oko);
      }
    }

    if (torso) {
      // Kaptur - jasnoszary walek/torus za karkiem.
      const kaptur = new THREE.Mesh(
        new THREE.TorusGeometry(0.062, 0.02, 8, 16, Math.PI * 1.3),
        new THREE.MeshStandardMaterial({ color: 0xd6d6d6, roughness: 0.8 }),
      );
      kaptur.position.set(0, 0.17, -0.035);
      kaptur.rotation.set(Math.PI / 2.1, 0, Math.PI);
      kaptur.castShadow = true;
      torso.add(kaptur);

      // Dwa sznurki kaptura z metalicznymi koncowkami z przodu.
      for (const side of [-1, 1]) {
        const sznurek = new THREE.Mesh(
          new THREE.CylinderGeometry(0.004, 0.004, 0.09, 6),
          new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.6 }),
        );
        sznurek.position.set(side * 0.025, 0.075, 0.058);
        sznurek.rotation.set(0.15, 0, side * 0.08);
        sznurek.castShadow = true;
        torso.add(sznurek);

        const koncowka = new THREE.Mesh(
          new THREE.CylinderGeometry(0.008, 0.008, 0.02, 8),
          new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.8, roughness: 0.3 }),
        );
        koncowka.position.set(side * 0.026, 0.028, 0.06);
        koncowka.castShadow = true;
        torso.add(koncowka);
      }

      // Pasek torby czarny, ukosnie przez tors.
      const pasek = new THREE.Mesh(
        new THREE.BoxGeometry(0.028, 0.24, 0.012),
        new THREE.MeshStandardMaterial({ color: 0x0d0d0d, roughness: 0.7 }),
      );
      pasek.position.set(0.02, 0.02, 0.045);
      pasek.rotation.z = Math.PI / 7;
      pasek.castShadow = true;
      torso.add(pasek);
    }

    if (armLeft) {
      // Zegarek czarny na nadgarstku (dol reki - rig Kenneya, reka zwisa
      // wzdluz ciala w spoczynku).
      const zegarek = new THREE.Mesh(
        new THREE.CylinderGeometry(0.026, 0.026, 0.014, 12),
        new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.6, roughness: 0.35 }),
      );
      zegarek.position.set(0.006, -0.29, 0.006);
      zegarek.rotation.set(Math.PI / 2, 0, 0);
      zegarek.castShadow = true;
      armLeft.add(zegarek);
    }
  }

  /** Dwa plaskie polfoki DOBIERZ/PASUJ (widoczne tylko w fazie WYBOR). */
  _budujGlowZnaczniki() {
    const teksturaBiala = zaladujTeksturaEtykietyPodlogi('DOBIERZ', 'rgba(255,255,255,0.30)', '#0a0a0a', 'rgba(255,255,255,0.95)');
    const teksturaCzarna = zaladujTeksturaEtykietyPodlogi('PASUJ', 'rgba(10,10,10,0.55)', '#ffe15c', 'rgba(255,255,255,0.85)');

    const geo = new THREE.PlaneGeometry(3.3, 6.6);

    const biala = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: teksturaBiala,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }));
    biala.rotation.x = -Math.PI / 2;
    biala.position.set(-1.68, GLOW_Y, 0);
    biala.visible = false;
    this.boss.scene.add(biala);

    const czarna = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: teksturaCzarna,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }));
    czarna.rotation.x = -Math.PI / 2;
    czarna.position.set(1.68, GLOW_Y, 0);
    czarna.visible = false;
    this.boss.scene.add(czarna);

    this._glowDobierz = biala;
    this._glowPasuj = czarna;
  }

  playAction(name, opts = {}) {
    const clip = THREE.AnimationClip.findByName(this.animations, name);
    if (!clip || !this.mixer) return null;
    const next = this.mixer.clipAction(clip);
    if (opts.once) {
      next.setLoop(THREE.LoopOnce);
      next.clampWhenFinished = true;
    }
    if (this.currentAction === next) {
      if (opts.forceRestart) next.reset().play();
      return next;
    }
    if (this.currentAction && !opts.hard) {
      this.currentAction.crossFadeTo(next, 0.2, false);
    }
    next.reset().play();
    this.currentAction = next;
    return next;
  }

  // ================= WEJSCIE NA ARENE =================

  /** Boss idzie z tylu sceny (SPAWN_POS) do neutralnej kolumny x=0 (FINAL_POS). */
  beginEntrance() {
    // Kara zamrozona RAZ na starcie walki - 10% POCZATKOWEJ puli (patrz
    // zadanie: "ta sama kwota przy kazdej przegranej, nie przeliczana").
    const pula = this.boss.economy && this.boss.economy.state ? this.boss.economy.state.money : 0;
    this.kara = Math.max(1, Math.round(KARA_UDZIAL * pula));

    if (this.model) {
      this.model.position.copy(SPAWN_POS);
      this.model.lookAt(this.model.position.x, this.model.position.y, this.model.position.z + 10);
    }
    this.fazaWejscia = true;
    this._wejscieT = 0;
    audio.play('boss-wejscie');
    this.playAction('walk', { hard: true }) || this.playAction('idle', { hard: true });
    this.boss._log('spawn', 'Kristofer wchodzi na arene od tylu sceny');
  }

  _updateEntrance(delta) {
    this._wejscieT += delta;
    const u = Math.min(1, this._wejscieT / CZAS_WEJSCIA);
    if (this.model) {
      this.model.position.lerpVectors(SPAWN_POS, FINAL_POS, u);
      this.model.lookAt(this.model.position.x, this.model.position.y, this.model.position.z + 10);
    }
    if (u >= 1) {
      this.fazaWejscia = false;
      this.playAction('idle', { hard: true });
      this._rozpocznijRozdanie();
    }
  }

  // ================= TALIA / RECE (DETERMINISTYCZNE) =================

  _pobierzTalie() {
    if (this._deckCache && this._deckCache.round === this.round) return this._deckCache.karty;
    const seed = this.boss.economy.state.seedGry;
    const idWalki = this.boss.pendingTier;
    const rng = strumien(kluczTalii(seed, idWalki, this.round));
    const karty = tasuj(rng, TALIA);
    this._deckCache = { round: this.round, karty };
    return karty;
  }

  /** Reka bossa do WYSWIETLENIA - druga karta jako 'BACK' dopoki nie odkryta. */
  _kartyBossaWidok() {
    const deck = this._pobierzTalie();
    const out = [];
    if (this.bossCount >= 1) out.push(deck[0]);
    if (this.bossCount >= 2) out.push(this.hiddenRevealed ? deck[1] : 'BACK');
    for (let j = 0; j < this.bossCount - 2; j++) {
      out.push(deck[4 + Math.max(0, this.playerCount - 2) + j]);
    }
    return out;
  }

  /** Reka bossa NAPRAWDE (do liczenia wyniku) - zawsze prawdziwe karty. */
  _kartyBossaRealne() {
    const deck = this._pobierzTalie();
    const out = [];
    if (this.bossCount >= 1) out.push(deck[0]);
    if (this.bossCount >= 2) out.push(deck[1]);
    for (let j = 0; j < this.bossCount - 2; j++) {
      out.push(deck[4 + Math.max(0, this.playerCount - 2) + j]);
    }
    return out;
  }

  _kartyGraczy() {
    const deck = this._pobierzTalie();
    const out = [];
    if (this.playerCount >= 1) out.push(deck[2]);
    if (this.playerCount >= 2) out.push(deck[3]);
    for (let i = 0; i < this.playerCount - 2; i++) out.push(deck[4 + i]);
    return out;
  }

  // ================= ROZPOCZECIE NOWEGO ROZDANIA =================

  _rozpocznijRozdanie() {
    this.faza = 'ROZDANIE';
    this.fazaT = 0;
    this._dealSteps = [false, false, false, false];
    this.bossCount = 0;
    this.playerCount = 0;
    this.hiddenRevealed = false;
    this.remisCount = 0;
    this._resolveApplied = false;
    this._deckCache = null;
    this._bossDrawTimer = 0;
    audio.play('bj-rozdanie');
    this.boss._log('info', `Kristofer rozdaje karty - rozdanie #${this.round}`);
  }

  // ================= GLOWNA PETLA HOSTA =================

  /** Krok logiki gry - wolany WYLACZNIE na hoscie (patrz update() nizej). */
  _updateHost(delta) {
    if (this.faza === 'ROZDANIE') {
      this.fazaT += delta;
      for (let i = 0; i < KROKI_ROZDANIA.length; i++) {
        if (!this._dealSteps[i] && this.fazaT >= KROKI_ROZDANIA[i]) {
          this._dealSteps[i] = true;
          if (i === 0) this.bossCount = 1;
          else if (i === 1) this.bossCount = 2;
          else if (i === 2) this.playerCount = 1;
          else if (i === 3) this.playerCount = 2;
        }
      }
      if (this.fazaT >= KONIEC_ROZDANIA) {
        const sumaGraczy = sumujReke(this._kartyGraczy());
        if (sumaGraczy >= 21) {
          this._rozpocznijTureBossa();
        } else {
          this._rozpocznijWybor();
        }
      }
      return;
    }

    if (this.faza === 'WYBOR') {
      this.decyzjaT -= delta;
      if (this.decyzjaT <= 0) {
        this._rozstrzygnijDecyzje();
      }
      return;
    }

    if (this.faza === 'TURA_BOSSA') {
      this.fazaT += delta;
      if (!this.hiddenRevealed) {
        if (this.fazaT >= 0.6) {
          this.hiddenRevealed = true;
          audio.play('bj-karta');
        }
        return;
      }
      const sumaBossa = sumujReke(this._kartyBossaRealne());
      if (sumaBossa < 17) {
        this._bossDrawTimer -= delta;
        if (this._bossDrawTimer <= 0) {
          this.bossCount += 1;
          this._bossDrawTimer = ODSTEP_DOBIERANIA_BOSSA;
          audio.play('bj-karta');
        }
      } else {
        this._rozpocznijRozstrzygniecie();
      }
      return;
    }

    if (this.faza === 'ROZSTRZYGNIECIE') {
      if (!this._resolveApplied) {
        this._resolveApplied = true;
        this._zastosujWynik();
      }
      this.resolveT -= delta;
      if (this.resolveT <= 0 && this.faza === 'ROZSTRZYGNIECIE') {
        this.round += 1;
        this._rozpocznijRozdanie();
      }
      return;
    }
    // 'KONIEC_GRY' - nic juz sie nie dzieje, czeka na teardown (patrz
    // boss.onGameOver w main.js).
  }

  _rozpocznijWybor() {
    this.faza = 'WYBOR';
    this.decyzjaT = CZAS_WYBORU;
    showBossNotification(
      'boss',
      '🃏 KRISTOFER CZEKA NA DECYZJĘ!',
      'Białe pole (lewo, x<0) = <strong>DOBIERZ</strong>, czarne pole (prawo, x>0) = <strong>PASUJ</strong>. Większość decyduje!',
    );
    this.boss._log('info', `Rozdanie #${this.round} - faza WYBOR (${CZAS_WYBORU}s)`);
  }

  _rozstrzygnijDecyzje() {
    const { lewo, prawo } = this.boss._countBySide();
    if (lewo === prawo) {
      this.remisCount += 1;
      this.boss._log('bad', `Remis DOBIERZ/PASUJ (${lewo}:${prawo}) - odliczanie od nowa (remis ${this.remisCount}/${REMISY_DO_AUTO_PASU})`);
      if (this.remisCount >= REMISY_DO_AUTO_PASU) {
        showBossNotification('help', '⏱️ REMIS 3x Z RZĘDU!', 'Zabezpieczenie: gracze automatycznie <strong>PASUJĄ</strong>.');
        this.remisCount = 0;
        this._wykonajPas();
      } else {
        showBossNotification('help', '🤝 REMIS!', `Głosy ${lewo}:${prawo} - odliczanie zaczyna się od nowa.`);
        this.decyzjaT = CZAS_WYBORU;
      }
      return;
    }
    this.remisCount = 0;
    if (lewo > prawo) {
      this._wykonajDobranie();
    } else {
      this._wykonajPas();
    }
  }

  _wykonajDobranie() {
    this.playerCount += 1;
    audio.play('bj-karta');
    const suma = sumujReke(this._kartyGraczy());
    this.boss._log('good', `Większość DOBIERZ - gracze dobierają karte (suma ${suma})`);
    if (suma > 21) {
      this._rozpocznijRozstrzygniecie();
    } else if (suma === 21) {
      this._rozpocznijTureBossa();
    } else {
      this.faza = 'WYBOR';
      this.decyzjaT = CZAS_WYBORU;
    }
  }

  _wykonajPas() {
    this.boss._log('info', 'Większość PASUJ - gracze pasują, tura bossa');
    this._rozpocznijTureBossa();
  }

  _rozpocznijTureBossa() {
    this.faza = 'TURA_BOSSA';
    this.fazaT = 0;
    this._bossDrawTimer = ODSTEP_DOBIERANIA_BOSSA;
    this.boss._log('info', 'Tura Kristofera - odkrywa zakryta karte i dobiera do >=17');
  }

  _rozpocznijRozstrzygniecie() {
    this.faza = 'ROZSTRZYGNIECIE';
    this.resolveT = CZAS_ROZSTRZYGNIECIA;
    this._resolveApplied = false;
  }

  _zastosujWynik() {
    const kartyGraczy = this._kartyGraczy();
    const sumaGraczy = sumujReke(kartyGraczy);
    const kartyBossa = this._kartyBossaRealne();
    const sumaBossa = sumujReke(kartyBossa);

    let wynik; // 'WYGRANA' | 'PRZEGRANA' | 'PUSH'
    if (sumaGraczy > 21) wynik = 'PRZEGRANA';
    else if (sumaBossa > 21) wynik = 'WYGRANA';
    else if (sumaGraczy > sumaBossa) wynik = 'WYGRANA';
    else if (sumaGraczy < sumaBossa) wynik = 'PRZEGRANA';
    else wynik = 'PUSH';

    this.resultText = wynik;
    this.boss._log('info', `Rozstrzygniecie rozdania #${this.round}: gracze ${sumaGraczy} vs Kristofer ${sumaBossa} -> ${wynik}`);

    if (wynik === 'WYGRANA') {
      audio.play('bj-wygrana');
      showBossNotification(
        'hit',
        '🃏 WYGRANA!',
        `Gracze ${sumaGraczy} vs Kristofer ${sumaBossa} - <strong>Kristofer traci ${DMG_ZA_WYGRANA} HP!</strong>`,
      );
      this.boss.damage(DMG_ZA_WYGRANA);
    } else if (wynik === 'PRZEGRANA') {
      audio.play('bj-przegrana');
      const economy = this.boss.economy;
      if (economy) {
        // Przycieta do zera - pula nie moze zejsc na minus (kara moze byc
        // wieksza niz to, co akurat zostalo w puli tuz przed przegrana).
        economy.state.money = Math.max(0, economy.state.money - this.kara);
        if (this.boss.save) {
          try { this.boss.save(); } catch (err) { console.error('[boss-blackjack] Blad zapisu po przegranej:', err); }
        }
      }
      showBossNotification(
        'kill',
        '💸 PRZEGRANA!',
        `Gracze ${sumaGraczy} vs Kristofer ${sumaBossa} - tracicie <strong>${this.kara} zł</strong> z puli!`,
      );
      if (economy && economy.state.money <= 0) {
        this.faza = 'KONIEC_GRY';
        this.boss._log('bad', 'Pula gracza spadla do zera - GAME OVER');
        if (this.boss.onGameOver) {
          try {
            const wynikPromise = this.boss.onGameOver();
            if (wynikPromise && typeof wynikPromise.catch === 'function') {
              wynikPromise.catch((err) => console.error('[boss-blackjack] Blad w onGameOver:', err));
            }
          } catch (err) {
            console.error('[boss-blackjack] Blad w onGameOver:', err);
          }
        }
      }
    } else {
      showBossNotification('help', '➖ PUSH', `Remis ${sumaGraczy}:${sumaBossa} - nic się nie dzieje, nowe rozdanie.`);
    }
  }

  // ================= WIZUALIZACJA KART (host I widz) =================

  _usunSprite(sprite) {
    if (!sprite) return;
    this.boss.scene.remove(sprite);
    if (sprite.material) sprite.material.dispose();
  }

  _wyczyscKarty() {
    for (const s of this._spriteBoss) this._usunSprite(s);
    for (const s of this._spritePlayer) this._usunSprite(s);
    this._spriteBoss = [];
    this._spritePlayer = [];
  }

  _stworzSprite(kod, origin, index) {
    const tex = zaladujTeksturaKarty(kod, null);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(ROZMIAR_KARTY[0], ROZMIAR_KARTY[1], 1);
    sprite.position.set(origin.x + index * ODSTEP_KART, origin.y, origin.z);
    this.boss.scene.add(sprite);
    return sprite;
  }

  /** Ujednolica sceny 3D (sprite'y kart) z aktualnym stanem (round/count/hidden). */
  _synchronizujWidokKart() {
    if (this._renderRound !== this.round) {
      this._wyczyscKarty();
      this._renderRound = this.round;
      this._renderBossCount = 0;
      this._renderPlayerCount = 0;
      this._renderHiddenRevealed = false;
    }

    const kartyBossa = this._kartyBossaWidok();
    const kartyGraczy = this._kartyGraczy();

    // Boss - dopisz nowe karty
    while (this._spriteBoss.length < kartyBossa.length) {
      const i = this._spriteBoss.length;
      this._spriteBoss.push(this._stworzSprite(kartyBossa[i], BOSS_KARTY_ORIGIN, i));
      if (i > this._renderBossCount - 1) audio.play('bj-karta');
    }
    // Odkrycie zakrytej karty - podmiana tekstury drugiego sprite'a bossa.
    if (this.hiddenRevealed && !this._renderHiddenRevealed && this._spriteBoss[1]) {
      this._spriteBoss[1].material.map = zaladujTeksturaKarty(kartyBossa[1], null);
      this._spriteBoss[1].material.needsUpdate = true;
      this._renderHiddenRevealed = true;
    }

    // Gracze - dopisz nowe karty
    while (this._spritePlayer.length < kartyGraczy.length) {
      const i = this._spritePlayer.length;
      this._spritePlayer.push(this._stworzSprite(kartyGraczy[i], GRACZE_KARTY_ORIGIN, i));
      if (i > this._renderPlayerCount - 1) audio.play('bj-karta');
    }

    this._renderBossCount = this.bossCount;
    this._renderPlayerCount = this.playerCount;
  }

  // ================= PANEL DOM (sumy, faza, odliczanie) =================

  _updatePanelDOM() {
    const boss = this.boss;
    if (!boss.bjPanelEl) return;
    boss.bjPanelEl.classList.add('show');

    const kartyBossaWidok = this._kartyBossaWidok();
    const sumaBossaWidok = this.hiddenRevealed
      ? sumujReke(this._kartyBossaRealne())
      : sumujReke(kartyBossaWidok.filter((k) => k !== 'BACK'));
    const sumaGraczy = sumujReke(this._kartyGraczy());

    if (boss.bjSumBossEl) boss.bjSumBossEl.textContent = `Bank: ${this.bossCount > 0 ? sumaBossaWidok : '-'}${this.hiddenRevealed ? '' : ' (?)'}`;
    if (boss.bjSumPlayersEl) boss.bjSumPlayersEl.textContent = `Gracze: ${this.playerCount > 0 ? sumaGraczy : '-'}`;

    let fazaTekst = '';
    if (this.faza === 'ROZDANIE') fazaTekst = 'ROZDANIE KART...';
    else if (this.faza === 'WYBOR') fazaTekst = 'GŁOSUJCIE: DOBIERZ czy PASUJ?';
    else if (this.faza === 'TURA_BOSSA') fazaTekst = 'TURA KRISTOFERA...';
    else if (this.faza === 'ROZSTRZYGNIECIE') fazaTekst = this.resultText === 'WYGRANA' ? '🏆 WYGRANA GRACZY!' : this.resultText === 'PRZEGRANA' ? '💸 PRZEGRANA...' : '➖ PUSH';
    else if (this.faza === 'KONIEC_GRY') fazaTekst = 'KONIEC GRY';
    if (boss.bjFazaEl) boss.bjFazaEl.textContent = fazaTekst;

    const pokazTimer = this.faza === 'WYBOR';
    if (boss.bjTimerWrapEl) boss.bjTimerWrapEl.style.display = pokazTimer ? 'block' : 'none';
    if (pokazTimer && boss.bjTimerFillEl) {
      const frac = Math.max(0, this.decyzjaT / CZAS_WYBORU);
      boss.bjTimerFillEl.style.width = `${frac * 100}%`;
      boss.bjTimerFillEl.classList.toggle('danger', frac < 0.25);
    }
    if (boss.bjRemisEl) {
      boss.bjRemisEl.textContent = this.remisCount > 0 ? `Remisy pod rząd: ${this.remisCount}/${REMISY_DO_AUTO_PASU}` : '';
    }
  }

  // ================= UPDATE GLOWNY =================

  update(delta) {
    if (this.mixer) this.mixer.update(delta);

    if (this.fazaWejscia) {
      this._updateEntrance(delta);
      return;
    }

    const jestemHostem = !this.boss.czyNaliczanieDozwolone || this.boss.czyNaliczanieDozwolone();
    if (jestemHostem) this._updateHost(delta);

    this._synchronizujWidokKart();
    this._updatePanelDOM();

    if (this._glowDobierz) this._glowDobierz.visible = this.faza === 'WYBOR';
    if (this._glowPasuj) this._glowPasuj.visible = this.faza === 'WYBOR';
  }

  // ================= SPRZATANIE =================

  teardown() {
    this._wyczyscKarty();
    if (this._glowDobierz) {
      this.boss.scene.remove(this._glowDobierz);
      this._glowDobierz.geometry.dispose();
      this._glowDobierz.material.dispose();
      this._glowDobierz = null;
    }
    if (this._glowPasuj) {
      this.boss.scene.remove(this._glowPasuj);
      this._glowPasuj.geometry.dispose();
      this._glowPasuj.material.dispose();
      this._glowPasuj = null;
    }
    if (this.boss.bjPanelEl) this.boss.bjPanelEl.classList.remove('show');
    this.mixer = null;
    this.currentAction = null;
  }

  // ================= SYNCHRONIZACJA =================

  getSyncState() {
    return {
      round: this.round,
      faza: this.faza,
      fazaT: this.fazaT,
      dealSteps: this._dealSteps,
      bossCount: this.bossCount,
      playerCount: this.playerCount,
      hiddenRevealed: this.hiddenRevealed,
      decyzjaT: this.decyzjaT,
      remisCount: this.remisCount,
      resolveT: this.resolveT,
      resultText: this.resultText,
      kara: this.kara,
    };
  }

  /** Widz WYLACZNIE wyswietla zsynchronizowany stan - host jest zrodlem prawdy. */
  applySync(state) {
    if (!state) return;
    if (typeof state.round === 'number') this.round = state.round;
    if (typeof state.faza === 'string') this.faza = state.faza;
    if (typeof state.fazaT === 'number') this.fazaT = state.fazaT;
    if (Array.isArray(state.dealSteps)) this._dealSteps = state.dealSteps.slice();
    if (typeof state.bossCount === 'number') this.bossCount = state.bossCount;
    if (typeof state.playerCount === 'number') this.playerCount = state.playerCount;
    if (typeof state.hiddenRevealed === 'boolean') this.hiddenRevealed = state.hiddenRevealed;
    if (typeof state.decyzjaT === 'number') this.decyzjaT = state.decyzjaT;
    if (typeof state.remisCount === 'number') this.remisCount = state.remisCount;
    if (typeof state.resolveT === 'number') this.resolveT = state.resolveT;
    if (typeof state.resultText === 'string') this.resultText = state.resultText;
    if (typeof state.kara === 'number') this.kara = state.kara;
  }

  /** Widz dolaczajacy w trakcie walki - ustawienie od razu w finalnej pozycji. */
  startFromSync(state) {
    if (this.model) {
      this.model.position.copy(FINAL_POS);
      this.model.lookAt(this.model.position.x, this.model.position.y, this.model.position.z + 10);
    }
    this.playAction('idle', { hard: true });
    this.applySync(state);
  }
}
