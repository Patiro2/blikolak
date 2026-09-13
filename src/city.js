import * as THREE from 'three';
import { loadForest, loadArcade, loadDungeon, loadPirate, loadArena, loadCubePets } from './assets.js';

// Tlo gry: proceduralne miasto noca wokol i ponizej areny. Arena (pokoj 7x7
// ze scianami, patrz scene.js) zostaje DOKLADNIE taka, jaka jest - stoi na
// wyniesionym betonowym placu (jedna duza bryla, PLAZA_*), a miasto (ulice,
// budynki, samochody) zyje na nizszym poziomie ulicy wokol tego placu.
//
// W zadnym z 10 pakietow Kenney w tym projekcie nie ma modeli budynkow
// miejskich/ulic/samochodow - miasto jest w calosci zbudowane z prymitywow
// Three.js (BoxGeometry + PlaneGeometry), tekstury okien/ulicy generowane raz
// na <canvas> (ten sam wzorzec co createFloorGridMesh w scene.js).
//
// Wydajnosc: budynki to JEDEN InstancedMesh (+ druga InstancedMesh na neonowe
// akcenty), samochody to trzy InstancedMesh (nadwozie, przednie/tylne swiatla)
// - wszystkie ze wspoldzielona geometria i materialem. update(delta) NIE
// alokuje niczego w petli - przelicza macierze przez wspolne, wielokrotnie
// uzywane obiekty tymczasowe (dummy/scratch).

const PLAZA_HALF = 6.5; // polowa boku betonowego placu, na ktorym stoi arena (arena siega do 3.5)
// Wierzch placu MUSI lezec ponizej y = 0. Kafle podlogi areny (Kenney floor.glb)
// zajmuja y od 0 do 0.025 i maja material DoubleSide, wiec ich DOLNA sciana
// (dokladnie na y = 0) nie jest odrzucana przez back-face culling i normalnie
// zapisuje glebie. Gdy wierzch placu tez lezal na y = 0, pod cala arena bylo
// 49 par wspolplaszczyznowych powierzchni - to dawalo migotanie posadzki przy
// ruchu kamery. Zmierzone na prawdziwym plotnie: ukrycie placu zbijalo wskaznik
// oscylacji obrazu z 0.104 do 0.030, czyli 3.5-krotnie (patrz diag.js).
const PLAZA_TOP_Y = -0.02; // wierzch placu - 2 cm PONIZEJ posadzki areny
const CITY_GROUND_Y = -2.2; // poziom ulicy (dolny poziom miasta)
const PLAZA_HEIGHT = PLAZA_TOP_Y - CITY_GROUND_Y;

// --- Foreground: zielono-miejski pierscien TUZ przy arenie (patrz _buildForeground) ---
// Kamera (OrbitControls, patrz scene.js) orbituje wokol LOOK_TARGET ~ (0,0.65,0.1)
// z maxDistance=17 (podniesione z 8.5 na zyczenie wlasciciela - wyraznie wieksze
// oddalenie), wiec teoretyczny najdalszy promien kamery od (0,0,0) to
// ~17 + |target| ~= 17.66 j. Niskie elementy (krzaki/kamienie, <0.6 j.) sa
// bezpieczne w kazdej odleglosci - nie siegaja wysokosci kamery/glowy postaci.
// WYSOKIE elementy (drzewa/budynki) MUSZA staC poza tym promieniem, inaczej w
// jakims kacie kamery znajda sie miedzy kamera a arena i zaslonia rozgrywke.
const FOREGROUND_APRON_HALF = 19.3; // polowa boku zielonego "trawnika" rozszerzajacego plac
const FOREGROUND_LOW_MIN = 6.7; // tuz za krawedzia oryginalnego placu (6.5) - nizej niz wysokosc kamery, bezpieczne przy kazdym maxDistance
const FOREGROUND_LOW_MAX = 8.6; // niska zielen - bezpieczna wszedzie
const FOREGROUND_TALL_MIN = 18.2; // margines bezpieczenstwa ponad teoretyczne 17.66
const FOREGROUND_TALL_MAX = 19.1; // w granicach apronu (19.3)
const FOREGROUND_SLOTS = 26; // rozstaw katowy - "skomponowane" sloty, nie czysty losowy rozrzut

const CITY_HALF = 44; // zasieg miasta (budynki/ulice) od centrum - podniesione z 34, zeby pierscien budynkow (za nowym keepout=26) mial podobna grubosc jak wczesniej (18 j.)
const BUILDING_GRID = 4; // rozstaw siatki dzialek budynkow
// Wolna strefa (promien od centrum sceny) bez budynkow. OrbitControls
// (patrz scene.js) pozwala kamerze oddalic sie do maxDistance = 17 od celu
// blisko origin - promien MUSI miec wyrazny margines ponad to, inaczej
// wysoki budynek staje tuz przy kamerze i zaslania cala scene (zmierzone
// empirycznie przy starym maxDistance=8.5/keepout=16 - przy promieniu 10 tak
// sie wlasnie dzialo, margines keepout-maxDistance ~7.5 byl bezpieczny).
// Zachowujemy ten sam margines: 26 - 17 = 9, wyraznie ponad FOREGROUND_TALL_MAX (19.1).
const BUILDING_KEEPOUT_RADIUS = 26;
const BUILDING_FOOTPRINT = 2.3; // szerokosc/glebokosc dzialki budynku (mniejsza niz rozstaw siatki - zostaw ulice)

const LOOP_HALF_SIZES = [15, 19, 23, 27]; // promienie petli ulic (samochody krazą po obwodzie prostokata)
// Auta stoja na CITY_GROUND_Y=-2.2, ~2.85 j. ponizej LOOK_TARGET.y (0.65) - nawet
// przy nowym maxDistance=17 (kamera nisko, ~1.3 j. wysokosci przy maxPolarAngle)
// linia wzroku kamera->cel na promieniu najblizszej petli (15) przechodzi ~1.2 j.
// nad ziemia, czyli ok. 3.2 j. NAD autami - auta nie wchodza miedzy kamere a arene.
const CARS_PER_LOOP = 10;

// Mgla MUSI zaczynac sie poza najdalszym mozliwym punktem areny od kamery -
// przy maxDistance=17 (OrbitControls) i promieniu areny ~5 od celu, w
// skrajnym ustawieniu kamery to nawet ~22.7 jednostki (17.66 + 5, zaokraglone
// w gore jako bezpieczny margines). FOG_NEAR=23 trzyma arene i postacie zawsze
// calkowicie poza zasiegiem mgly.
const FOG_NEAR = 23;
// CITY_HALF podniesiony do 44 (patrz wyzej), wiec podloze ulicy siega polowy
// CITY_HALF*2+20 = 54, jego przekatna to ~54*sqrt2 ~= 76.4. Najblizsza mozliwa
// odleglosc kamery do krawedzi swiata "na wprost" (przez cel, w skrajnym
// maxDistance=17) to R + 54 ~= 71.7 j. FOG_FAR=55 zostawia >16 j. marginesu
// ponizej tej wartosci - krawedz swiata jest zawsze calkowicie wtopiona we
// mgle (ktora ma ten sam kolor co tlo sceny 0x0e1118 - brak widocznego szwu),
// a najdalsze budynki (za keepout radius 26) sa wyraznie wtopione we mgle,
// arena (poza zasiegiem FOG_NEAR=23) nadal nietknieta.
const FOG_FAR = 55;

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

// --- Seedowany PRNG (mulberry32) - uzywany WYLACZNIE przez rozmieszczenie
// rekwizytow na przedpolu (_buildForegroundProps), zeby kazdy widz na streamie
// widzial DOKLADNIE ten sam, powtarzalny "nasrany" ukladu scenki miedzy
// przeladowaniami strony (patrz wymaganie #2 w zadaniu). Reszta miasta
// (budynki daleko, samochody, latarnie) zostaje na Math.random() jak dotad -
// nie musi byc identyczna klatka po klatce, nikt tego nie porownuje 1:1.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rrange(rng, min, max) {
  return min + rng() * (max - min);
}

/** Losowy punkt blizej srodka zakresu niz plaski rozklad (dwa losowania, minimum) - daje "ciasne jadro, rzadszy ogon" gestosci w klastrach. */
function biasedTowards(rng, min, max, toward) {
  const u = Math.min(rng(), rng());
  return toward === 'low' ? min + u * (max - min) : max - u * (max - min);
}

/**
 * Generuje raz teksture "okien" budynku na canvasie - siatka przygaszonych
 * kwadracikow na ciemnogranatowym tle.
 *
 * Zmierzony problem (zrzuty z domyslnego kadru): przy siatce 6x12 i
 * tex.repeat.set(2,5) na ekranie wychodzilo 12x60 okien na sciane, a budynki
 * stoja 26-44 jednostki od kamery (FOV 42) - pojedyncze okno wypadalo ponizej
 * jednego piksela, co przy braku mipmap/anizotropii daje migotliwy szum
 * (telewizyjny snieg) zamiast spokojnej panoramy swiatel. Naprawa ma dwie
 * czesci: (1) mniejsza gestosc siatki + mniejszy repeat, zeby pojedyncze okno
 * mialo wyraznie wiecej niz piksel na ekranie z domyslnego kadru, (2)
 * mipmapy + anizotropia (patrz applyTextureFiltering ponizej), ktore usuwaja
 * pozostaly alias przy okazjonalnym patrzeniu pod katem/z oddali.
 * Kontrast tez zbity: granat zamiast czerni, przygaszone kolory okien,
 * mniej zapalonych okien (0.38 -> 0.22).
 */
function createWindowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#12151f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cols = 4;
  const rows = 7;
  const cellW = canvas.width / cols;
  const cellH = canvas.height / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Nie kazde okno swieci - losowa mieszanka zgaszonych/zapalonych, jak w prawdziwym miescie noca
      const lit = Math.random() < 0.22;
      if (!lit) continue;
      const warm = Math.random() < 0.6;
      ctx.fillStyle = warm ? '#c9a45f' : '#6f9fb8';
      const pad = 5;
      ctx.fillRect(c * cellW + pad, r * cellH + pad, cellW - pad * 2, cellH - pad * 2);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1.4, 3);
  return tex;
}

/**
 * Wlacza filtrowanie anizotropowe + mipmapy na teksturze okien, zeby
 * usunac resztkowy alias na drobnych, odleglych budynkach (drugi filar
 * naprawy migotania - patrz komentarz w createWindowTexture). Bezpieczna
 * na brak renderera (main.js moze wywolac build(scene) bez drugiego
 * argumentu - w takim razie tekstura zostaje z domyslnym filtrowaniem
 * three.js, gra dalej dziala).
 */
function applyTextureFiltering(tex, renderer) {
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  if (renderer && renderer.capabilities && typeof renderer.capabilities.getMaxAnisotropy === 'function') {
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
  tex.needsUpdate = true;
}

/** Generuje raz teksture nawierzchni ulicy - asfalt z jasnymi pasami jezdni. */
function createStreetTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#14151c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Delikatna faktura asfaltu (losowe plamki)
  ctx.fillStyle = 'rgba(255,255,255,0.02)';
  for (let i = 0; i < 400; i++) {
    const x = Math.random() * canvas.width;
    const y = Math.random() * canvas.height;
    ctx.fillRect(x, y, 2, 2);
  }

  // Zwykle, matowe pasy jezdni na krzyz (siatka ulic) - w nocnej wersji mialy
  // shadowBlur/jaskrawy poblask (swiecaca farba drogowa); w dzien to zwykle,
  // odblaskowe, ale NIE swiecace pasy (bez shadowBlur).
  ctx.strokeStyle = 'rgba(255, 214, 110, 0.85)';
  ctx.lineWidth = 5;
  ctx.setLineDash([26, 18]);
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2, 0);
  ctx.lineTo(canvas.width / 2, canvas.height);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, canvas.height / 2);
  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();

  // Krawedz kafla ulicy - dawniej neonowo-zielona (marka Kicka, nocny akcent
  // "sprzedawany" przez selektywny bloom - usuniety, patrz main.js). W dzien
  // zwykla, przygaszona krawedz/fuga plyty betonowej zamiast neonu.
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(120, 120, 110, 0.3)';
  ctx.lineWidth = 6;
  ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(CITY_HALF, CITY_HALF);
  return tex;
}

/**
 * Rysuje miekkie, wielotonowe "placki" trawy na canvasie - kilkadziesiat
 * duzych (promien >= 26px), polprzezroczystych kol w kilku odcieniach
 * zieleni. Duzy promien celowo - CLAUDE.md/plan zadania ostrzega przed
 * drobnym szumem, ktory z daleka miga (alias); plamy tej wielkosci przy
 * skali canvasu uzywanej ponizej (plaza/apron) maja co najmniej kilkanascie
 * centymetrow w swiecie gry, wiec sa stabilne wizualnie przy ruchu kamery.
 */
function paintGrassBlobs(ctx, size, count, palette, radiusRange) {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = randRange(radiusRange[0], radiusRange[1]);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    const color = palette[Math.floor(Math.random() * palette.length)];
    grad.addColorStop(0, `rgba(${color}, 0.55)`);
    grad.addColorStop(1, `rgba(${color}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Generuje raz teksture nawierzchni placu pod arena (uklada sie na
 * PlazaGroundMesh, cienkiej nakladce tuz nad betonowym cokolem - patrz
 * _buildPlaza). Trawa z wieloma odcieniami, przetarta ziemia w pierscieniu
 * tuz przy plotku granicy areny (fenceEdge=3.8, patrz scene.js) i 4 kamienne
 * sciezki prowadzace od plotka do krawedzi placu (PLAZA_HALF=6.5) w stronach
 * N/E/S/W - zgodnie z orientacja plotkow granicy.
 */
function createPlazaGroundTexture() {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#3a5a34';
  ctx.fillRect(0, 0, size, size);

  paintGrassBlobs(ctx, size, 90, ['58,90,50', '70,110,62', '46,74,40', '85,125,70'], [26, 60]);

  // Przetarta ziemia dookola plotka granicy areny (kwadratowy pas, plotek
  // siega do ok. +-3.9 j. z naroznikami - patrz FENCE_EDGE+CORNER_SIZE/2 w
  // scene.js). 1 j. = size/(PLAZA_HALF*2) = 1024/13 ~= 78.77 px.
  const pxPerUnit = size / (6.5 * 2);
  const center = size / 2;
  const dirtHalf = 4.35 * pxPerUnit;
  ctx.save();
  ctx.strokeStyle = 'rgba(150, 115, 78, 0.55)';
  ctx.lineWidth = 1.1 * pxPerUnit;
  ctx.lineJoin = 'round';
  ctx.strokeRect(center - dirtHalf, center - dirtHalf, dirtHalf * 2, dirtHalf * 2);
  ctx.strokeStyle = 'rgba(120, 92, 62, 0.35)';
  ctx.lineWidth = 0.4 * pxPerUnit;
  ctx.strokeRect(center - dirtHalf, center - dirtHalf, dirtHalf * 2, dirtHalf * 2);
  ctx.restore();

  // 4 kamienne sciezki od przetartej ziemi do krawedzi placu, w kierunkach
  // odpowiadajacych bokom plotka (N/E/S/W).
  const pathHalfW = 0.55 * pxPerUnit;
  const pathStart = dirtHalf;
  const pathEnd = size / 2;
  const drawStoneStrip = (horizontal) => {
    for (const sign of [-1, 1]) {
      ctx.save();
      if (horizontal) {
        const x0 = center + sign * pathStart;
        const x1 = center + sign * pathEnd;
        ctx.fillStyle = '#8a8579';
        ctx.fillRect(Math.min(x0, x1), center - pathHalfW, Math.abs(x1 - x0), pathHalfW * 2);
        // Fugi kamiennej sciezki - kilka poprzecznych kresek
        ctx.strokeStyle = 'rgba(60,56,48,0.4)';
        ctx.lineWidth = 2;
        const steps = 8;
        for (let i = 1; i < steps; i++) {
          const x = x0 + (x1 - x0) * (i / steps);
          ctx.beginPath();
          ctx.moveTo(x, center - pathHalfW);
          ctx.lineTo(x, center + pathHalfW);
          ctx.stroke();
        }
      } else {
        const y0 = center + sign * pathStart;
        const y1 = center + sign * pathEnd;
        ctx.fillStyle = '#8a8579';
        ctx.fillRect(center - pathHalfW, Math.min(y0, y1), pathHalfW * 2, Math.abs(y1 - y0));
        ctx.strokeStyle = 'rgba(60,56,48,0.4)';
        ctx.lineWidth = 2;
        const steps = 8;
        for (let i = 1; i < steps; i++) {
          const y = y0 + (y1 - y0) * (i / steps);
          ctx.beginPath();
          ctx.moveTo(center - pathHalfW, y);
          ctx.lineTo(center + pathHalfW, y);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  };
  drawStoneStrip(true);
  drawStoneStrip(false);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * Generuje raz teksture "dzikiego" terenu na apronie (do FOREGROUND_APRON_HALF
 * = 19.3) - wielotonowa trawa i szeroka asfaltowa obwodnica z pasami na
 * promieniu 12.5 (dzieli teren na gesty pas scenek/rekwizytow blizej placu i
 * rzadszy pas dalekiej zieleni/zabudowy na horyzoncie - patrz
 * _buildForegroundProps dla konkretnych promieni i deterministycznego
 * rozmieszczenia). Dawniej rysowala tu tez 6 sciezek pod stalymi katami do
 * (wtedy stalych) pozycji klastrow - usuniete, bo klastry stoja teraz w
 * losowych miejscach (patrz raport zadania - "koniec z symetria").
 */
function createApronGroundTexture() {
  const size = 1536;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = 19.3;
  const pxPerUnit = size / (half * 2);
  const center = size / 2;

  ctx.fillStyle = '#33502f';
  ctx.fillRect(0, 0, size, size);
  paintGrassBlobs(ctx, size, 260, ['61,97,54', '74,115,64', '44,69,39', '92,138,78', '58,90,52'], [45, 130]);

  // Dawniej: 6 promienistych sciezek gruntowych pod kazdym z 6 klastrow
  // rozstawionych co 60 stopni. Klastry rekwizytow sa teraz rozrzucone
  // NIEREGULARNIE (patrz _buildForegroundProps/CLUSTER_THEMES) - staly wzor
  // 6 sciezek pod stalymi katami wygladalby jak szprychy kola pod scenka,
  // ktora juz nie jest w tych miejscach. Same "wydeptane" plamy gruntu wokol
  // realnych pozycji klastrow dokladaja modele Kenney (patch-dirt) w 3D -
  // wystarczy, teren pod spodem zostaje po prostu wielotonowa trawa.

  // Szeroka obwodnica asfaltowa na promieniu 12.5 - pierscien z przerywana
  // linia jezdni i jasniejszym kraweznikiem po obu stronach.
  const ringR = 12.5 * pxPerUnit;
  const ringW = 1.6 * pxPerUnit;
  ctx.save();
  // Jasny kraweznik pod spodem (szerszy stroke), potem ciemny asfalt na
  // wierzchu (wezszy) - zostawia widoczny pasek kraweznika po obu stronach.
  ctx.strokeStyle = 'rgba(210,210,200,0.55)';
  ctx.lineWidth = ringW + 6;
  ctx.beginPath();
  ctx.arc(center, center, ringR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#1c1d24';
  ctx.lineWidth = ringW;
  ctx.beginPath();
  ctx.arc(center, center, ringR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 214, 110, 0.65)';
  ctx.lineWidth = 4;
  ctx.setLineDash([30, 22]);
  ctx.beginPath();
  ctx.arc(center, center, ringR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Drobne kepki kwiatow/krzewow - male grupki kolorowych kropek, wielkosc
  // pojedynczej kropki >= 5px (nie pojedynczy piksel - patrz uwaga o aliasie
  // w CLAUDE.md/createWindowTexture) rozrzucone po trawie.
  const flowerColors = ['#ffd166', '#ff8fd6', '#f4f4f4', '#c084fc'];
  for (let i = 0; i < 70; i++) {
    const cx = Math.random() * size;
    const cy = Math.random() * size;
    const dist = Math.hypot(cx - center, cy - center) / pxPerUnit;
    if (dist < 7 || (dist > 11.5 && dist < 13.5) || dist > 18) continue; // omijaj plac/droge/skraj mgly
    const clusterSize = 3 + Math.floor(Math.random() * 4);
    const col = flowerColors[Math.floor(Math.random() * flowerColors.length)];
    ctx.fillStyle = col;
    for (let j = 0; j < clusterSize; j++) {
      const ox = cx + randRange(-14, 14);
      const oy = cy + randRange(-14, 14);
      ctx.beginPath();
      ctx.arc(ox, oy, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** Zwraca pozycje (x,z) i kierunek (kat rotation.y) na obwodzie prostokatnej petli ulicy dla dystansu s. */
function pointOnLoop(halfSize, s, out) {
  const side = halfSize * 2;
  const perim = side * 4;
  let u = s % perim;
  if (u < 0) u += perim;

  if (u < side) {
    out.x = -halfSize + u;
    out.z = -halfSize;
    out.heading = Math.PI / 2; // ruch w +X
  } else if (u < side * 2) {
    out.x = halfSize;
    out.z = -halfSize + (u - side);
    out.heading = 0; // ruch w +Z
  } else if (u < side * 3) {
    out.x = halfSize - (u - side * 2);
    out.z = halfSize;
    out.heading = -Math.PI / 2; // ruch w -X
  } else {
    out.x = -halfSize;
    out.z = halfSize - (u - side * 3);
    out.heading = Math.PI; // ruch w -Z
  }
  return out;
}

const CAR_COLORS = [0xff5c5c, 0xffd166, 0x53fc18, 0x4fd6ff, 0xb388ff, 0xff8fd6, 0xffffff, 0xff9f45];

export class CityBackground {
  constructor() {
    this.buildingMesh = null;
    this.neonMesh = null;
    this.carBodyMesh = null;
    this.carFrontLightMesh = null;
    this.carRearLightMesh = null;

    this.cars = []; // { loopHalf, progress, speed }
    this._dummy = new THREE.Object3D();
    this._pt = { x: 0, z: 0, heading: 0 };
    this._fwd = new THREE.Vector3();
  }

  build(scene, renderer) {
    // Kolor mgly = kolor horyzontu kopuly nieba (buildDaySkyDome w scene.js,
    // teraz przygaszony 0xaec4d6, nie 0xdcecf7) - musza sie zgadzac, inaczej
    // widac szew na styku odleglych budynkow i nieba.
    scene.fog = new THREE.Fog(0xaec4d6, FOG_NEAR, FOG_FAR);

    this._buildPlaza(scene, renderer);
    this._buildStreetGround(scene);
    this._buildBuildings(scene, renderer);
    this._buildCars(scene);
    this._buildForegroundApron(scene, renderer);
    this._buildStreetlamps(scene);
    // Asynchroniczne (GLB) - leci w tle, nie blokuje pierwszej klatki. Ewentualny
    // blad sieci/ladowania jest logowany, ale NIE wywraca reszty gry (patrz
    // main.js - city.build() nigdy nie jest await-owane).
    this._buildForegroundProps(scene, renderer).catch((err) => {
      console.error('[city] Nie udalo sie zbudowac foregroundu (drzewa/budynki):', err);
    });
  }

  // --- Zielony "apron" - lekko obnizone (o 0.005, zero Z-fightingu z placem)
  // rozszerzenie placu, na ktorym stoi caly zielono-miejski foreground. ---
  _buildForegroundApron(scene, renderer) {
    const geo = new THREE.BoxGeometry(FOREGROUND_APRON_HALF * 2, PLAZA_HEIGHT, FOREGROUND_APRON_HALF * 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1c2a1e, roughness: 1, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, CITY_GROUND_Y + PLAZA_HEIGHT / 2 - 0.005, 0);
    mesh.receiveShadow = true;
    scene.add(mesh);
    this.foregroundApronMesh = mesh;

    // Nakladka z wielotonowa trawa + sciezki gruntowe do klastrow rekwizytow +
    // asfaltowa obwodnica (patrz createApronGroundTexture) - cienka plaszczyzna
    // TUZ nad wierzchem apronu (ktory zostaje pod spodem, niewidoczny, samym
    // kolorem juz nie gra roli). Poziom Y = apron top (-0.025) + 0.004 =
    // -0.021: ponizej wierzchu placu (-0.02, plac go zaslania w swoim
    // obrysie, tak jak wczesniej robil to sam apron) i nad apronem - brak
    // wspolplaszczyznowosci z ktorakolwiek z tych dwoch powierzchni.
    const apronTopY = CITY_GROUND_Y + PLAZA_HEIGHT - 0.005; // = PLAZA_TOP_Y - 0.005
    const overlayGeo = new THREE.PlaneGeometry(FOREGROUND_APRON_HALF * 2, FOREGROUND_APRON_HALF * 2);
    const overlayTex = createApronGroundTexture();
    applyTextureFiltering(overlayTex, renderer);
    const overlayMat = new THREE.MeshStandardMaterial({ map: overlayTex, roughness: 1, metalness: 0 });
    const overlay = new THREE.Mesh(overlayGeo, overlayMat);
    overlay.rotation.x = -Math.PI / 2;
    overlay.position.set(0, apronTopY + 0.004, 0);
    overlay.receiveShadow = true;
    scene.add(overlay);
    this.apronGroundOverlay = overlay;
  }

  /**
   * Praktyczne "latarnie" wzdluz obwodnicy asfaltowej narysowanej w
   * createApronGroundTexture (promien 12.5) - jedyne PRAWDZIWE zrodla swiatla
   * dodane do dekoracji miasta poza juz istniejacymi emissive oknami/neonami
   * na dachach. Celowo BEZ THREE.PointLight per latarnia (kazda rzucalaby
   * wlasny krag oswietlenia i, gdyby mialy cienie, byla to byla kosztowna
   * shadow-mapa na kazda) - caly efekt "swiecacej latarni" to (1) maly,
   * emisyjny "klosz" (InstancedMesh, jeden draw call na WSZYSTKIE latarnie)
   * i (2) dodatkowy, addytywny Sprite-glow (SpriteMaterial, blending
   * Additive, depthWrite false) w tym samym miejscu - to jest DOKLADNIE ten
   * sam trik co juz uzywaja flagSprite/wordSprite w minigrach (patrz
   * flagbattle.js/tlumaczenia.js), tylko z additive blendingiem zamiast
   * zwyklego alpha. Latarnie stoja na promieniu apronu (12.5), wiec sa
   * WYRAZNIE dalej niz arena (promien ~3.8) - nie ingeruja w oswietlenie
   * bankomatu/postaci, czytaja sie jako tlo miasta.
   */
  _buildStreetlamps(scene) {
    const LAMP_COUNT = 10;
    const LAMP_RADIUS = 12.5; // ten sam promien co asfaltowa obwodnica w createApronGroundTexture
    const POLE_H = 1.55;
    const apronTopY = CITY_GROUND_Y + PLAZA_HEIGHT - 0.005; // patrz _buildForegroundApron

    const poleGeo = new THREE.CylinderGeometry(0.03, 0.045, POLE_H, 6);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x1c1e26, roughness: 0.55, metalness: 0.5 });
    const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, LAMP_COUNT);
    poleMesh.frustumCulled = false;
    poleMesh.castShadow = true;
    poleMesh.receiveShadow = true;

    // "Klosz" latarni - w dzien latarnie sa WYLACZONE (realistycznie, i
    // zgodnie z wymaganiem zadania "latarnie nie moga swiecic jak w nocy") -
    // emissiveIntensity zbita z 2.4 do 0.15, tyle zeby szklany klosz mial
    // lekki, cieply odblask od slonca, a nie wygladal jak wlaczona zarowka.
    const headGeo = new THREE.SphereGeometry(0.1, 8, 6);
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xffdca0,
      emissive: 0xffc978,
      emissiveIntensity: 0.15,
      roughness: 0.4,
    });
    const headMesh = new THREE.InstancedMesh(headGeo, headMat, LAMP_COUNT);
    headMesh.frustumCulled = false;

    // Dawniej kazda latarnia miala tez wlasny addytywny Sprite-glow (imitacja
    // swiecacej poswiaty nocnej latarni, czytany razem z selektywnym bloomem
    // - patrz historia tego pliku/main.js). W dziennej wersji latarnie sa
    // wylaczone (patrz headMat.emissiveIntensity powyzej) i nie ma juz
    // blooma (usuniety w main.js - patrz raport zadania), wiec ten sprite nie
    // mialby czego "sprzedawac": zostalby tylko jasna, biala plama widoczna w
    // pelnym sloncu, dokladnie to, czego zadanie zabrania ("latarnie nie moga
    // swiecic jak w nocy"). Usuniety calkowicie - dodatkowo oszczedza 10
    // draw calls (jeden Sprite na latarnie) i jedna teksture canvas.
    const dummy = new THREE.Object3D();

    for (let i = 0; i < LAMP_COUNT; i++) {
      const angle = (i / LAMP_COUNT) * Math.PI * 2 + randRange(-0.05, 0.05);
      const x = Math.sin(angle) * LAMP_RADIUS;
      const z = Math.cos(angle) * LAMP_RADIUS;
      const headY = apronTopY + POLE_H + 0.05;

      dummy.position.set(x, apronTopY + POLE_H / 2, z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      poleMesh.setMatrixAt(i, dummy.matrix);

      dummy.position.set(x, headY, z);
      dummy.updateMatrix();
      headMesh.setMatrixAt(i, dummy.matrix);
    }

    poleMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
    scene.add(poleMesh);
    scene.add(headMesh);
    this.streetlampPoleMesh = poleMesh;
    this.streetlampHeadMesh = headMesh;
  }

  /** Zwraca pierwszy THREE.Mesh znaleziony w scenie GLTF (kazdy model mini-forest ma dokladnie jeden). */
  _firstMesh(gltf) {
    let found = null;
    gltf.scene.traverse((o) => {
      if (!found && o.isMesh) found = o;
    });
    return found;
  }

  /**
   * Buduje pierscien zieleni/zabudowy dookola placu z modeli kenney_mini-forest
   * (assets/forest/, patrz assets.js loadForest) + kilku elementow z mini-arcade
   * (kolumny) i kilku proceduralnych brył budynkow w stylu dalekiego miasta, ale
   * cieplej zabarwionych, zeby czytac sie jako BLISKI, celowy foreground a nie
   * dalsza mgla. Kazdy typ modelu = jeden InstancedMesh (jedno wywolanie
   * loadForest zwraca DOKLADNIE jeden mesh na model - zweryfikowane w GLB), wiec
   * cala dodatkowa zabudowa to tylko kilkanascie dodatkowych draw calls,
   * niezaleznie od liczby instancji.
   */
  async _buildForegroundProps(scene, renderer) {
    const [
      tree, treeHigh, plant, rocksHigh, rocksLow, stones, fence, bStruct, bRoof,
      pTower, pStructure, pPalmStraight, pPalmBend, pFlag, pBarrel, pCrate,
      aStatue, aBanner,
      mFruit, mCart, mBasket, mFreezer, mBottleReturn,
      dWoodStruct, dWoodSupport, dBarrel, dTable, dChair,
      patchGrass, patchDirt, pGrass, pGrassPlant, pGrassFoliage,
      pDock, columnGltf,
      petDog, petCat, petFox, petBunny, petBee, petChick, petPig,
    ] = await Promise.all([
      loadForest('tree'), loadForest('tree-high'), loadForest('plant'),
      loadForest('rocks-high'), loadForest('rocks-low'), loadForest('stones'),
      loadForest('fence'), loadForest('building-structure'), loadForest('building-roof'),
      loadPirate('tower-watch'), loadPirate('structure'), loadPirate('palm-detailed-straight'),
      loadPirate('palm-bend'), loadPirate('flag-high-pennant'), loadPirate('barrel'), loadPirate('crate'),
      loadArena('statue'), loadArena('banner'),
      loadArcade('display-fruit'), loadArcade('shopping-cart'), loadArcade('shopping-basket'),
      loadArcade('freezers-standing'), loadArcade('bottle-return'),
      loadDungeon('wood-structure'), loadDungeon('wood-support'), loadDungeon('barrel'), loadDungeon('table'), loadDungeon('chair'),
      loadForest('patch-grass'), loadForest('patch-dirt'),
      loadPirate('grass'), loadPirate('grass-plant'), loadPirate('patch-grass-foliage'),
      loadPirate('structure-platform-dock-small'), loadArcade('column'),
      loadCubePets('animal-dog'), loadCubePets('animal-cat'), loadCubePets('animal-fox'),
      loadCubePets('animal-bunny'), loadCubePets('animal-bee'), loadCubePets('animal-chick'), loadCubePets('animal-pig'),
    ]);

    const dummy = new THREE.Object3D();

    // ========================================================================
    // Nowy system rozmieszczenia przedpola (patrz raport zadania): zamiast
    // pierscieni/stalych katow - garstka TEMATYCZNYCH "scenek" (kazda z
    // nieregularnym, losowym srodkiem, ciasnym jadrem i rzadszym "ogonem"
    // rekwizytow) + mnostwo pojedynczych obiektow rozrzuconych miedzy nimi +
    // nieregularny pas dalekiej zieleni/zabudowy na horyzoncie. Calosc jest
    // W PELNI deterministyczna (jeden seedowany PRNG, patrz mulberry32
    // powyzej) i pilnuje siebie sama przez rejection sampling: kazda
    // proponowana pozycja jest sprawdzana pod katem (1) areny+plotka,
    // (2) placu, (3) asfaltowej obwodnicy, (4) krawedzi apronu, (5) kolizji z
    // KAZDYM juz postawionym obiektem, (6) reguly wlasciciela "z>4 => tylko
    // niskie" (patrz CAMERA_NEAR_Z/LOW_H nizej). Odrzucone proby licza sie do
    // `rejections` (patrz raport w konsoli na koniec funkcji).
    // ========================================================================
    const rng = mulberry32(20260913); // staly seed = powtarzalny uklad dla kazdego widza/przeladowania

    const ARENA_KEEP_R = 4.15; // arena + plotek graniczny (fenceEdge=3.8 w scene.js + margines)
    const PLAZA_INNER_R = 6.6; // krawedz wlasciwego placu (PLAZA_HALF=6.5) + margines
    const APRON_OUTER_R = 18.7; // margines przed krawedzia apronu (FOREGROUND_APRON_HALF=19.3)
    const RING_R = 12.5, RING_HALF_W = 1.25; // asfaltowa obwodnica (patrz createApronGroundTexture)
    const CAMERA_NEAR_Z = 4; // wymaganie #4 zadania: "strefa z>4 i przed kamera - tylko niskie obiekty"
    const LOW_H = 0.6;
    const MID_MIN_R = PLAZA_INNER_R;
    const MID_MAX_R = RING_R - RING_HALF_W - 0.15; // pas glownej gestej scenografii, przed obwodnica
    const FAR_MIN_R = RING_R + RING_HALF_W + 0.3; // pas dalekiej zieleni/zabudowy, za obwodnica
    const FAR_MAX_R = APRON_OUTER_R;

    const occupied = []; // {x,z,r} - kazdy juz postawiony POJEDYNCZY obiekt (nie caly klaster)
    const clusterCenters = []; // {x,z,r} - tylko do rozstawiania srodkow scenek miedzy soba
    let attempts = 0;
    let rejections = 0;

    const zoneBlocked = (x, z, r) => {
      const d = Math.hypot(x, z);
      if (d - r < ARENA_KEEP_R) return true;
      if (d - r < PLAZA_INNER_R) return true;
      if (d + r > APRON_OUTER_R) return true;
      if (Math.abs(d - RING_R) < RING_HALF_W + r) return true;
      return false;
    };
    const heightOkForZ = (z, height) => !(z > CAMERA_NEAR_Z && height > LOW_H);
    const overlapsOccupied = (x, z, r) => occupied.some((o) => Math.hypot(x - o.x, z - o.z) < o.r + r + 0.06);

    /** Losuje srodek scenki w podanym pasie promieni, z opcjonalnym pulapem Z (dla wysokich tematow - patrz heightOkForZ) i minimalnym odstepem od pozostalych srodkow. */
    const pickClusterCenter = (rMin, rMax, spread, maxZ) => {
      for (let i = 0; i < 100; i++) {
        attempts++;
        const angle = rng() * Math.PI * 2;
        const radius = rrange(rng, rMin, rMax);
        const x = Math.sin(angle) * radius;
        const z = Math.cos(angle) * radius;
        if (maxZ != null && z > maxZ) { rejections++; continue; }
        if (zoneBlocked(x, z, spread * 0.7)) { rejections++; continue; }
        if (clusterCenters.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + spread + 0.6)) { rejections++; continue; }
        clusterCenters.push({ x, z, r: spread });
        return { x, z };
      }
      rejections++;
      return null; // scenka pominieta - miejsce sie nie znalazlo (zliczone w raporcie)
    };

    /** Losuje wolne miejsce dla pojedynczego rekwizytu wokol centrum klastra (ciasne jadro, rzadszy ogon - patrz biasedTowards), sprawdzajac WSZYSTKIE globalne ograniczenia. */
    const placeNear = (center, spread, footprintR, height, tries = 30) => {
      for (let i = 0; i < tries; i++) {
        attempts++;
        const angle = rng() * Math.PI * 2;
        const dist = biasedTowards(rng, 0, spread, 'low');
        const x = center.x + Math.sin(angle) * dist;
        const z = center.z + Math.cos(angle) * dist;
        if (zoneBlocked(x, z, footprintR) || overlapsOccupied(x, z, footprintR) || !heightOkForZ(z, height)) {
          rejections++;
          continue;
        }
        occupied.push({ x, z, r: footprintR });
        return { x, z };
      }
      rejections++;
      return null;
    };

    /** Jak placeNear, ale niezalezne od zadnego centrum - dla pojedynczych rekwizytow rozrzuconych "miedzy" scenkami w calym pasie promieni. */
    const placeLoose = (rMin, rMax, footprintR, height, maxZ, tries = 40) => {
      for (let i = 0; i < tries; i++) {
        attempts++;
        const angle = rng() * Math.PI * 2;
        const radius = rrange(rng, rMin, rMax);
        const x = Math.sin(angle) * radius;
        const z = Math.cos(angle) * radius;
        if (maxZ != null && z > maxZ) { rejections++; continue; }
        if (zoneBlocked(x, z, footprintR) || overlapsOccupied(x, z, footprintR) || !heightOkForZ(z, height)) {
          rejections++;
          continue;
        }
        occupied.push({ x, z, r: footprintR });
        return { x, z };
      }
      rejections++;
      return null;
    };

    /** Wymiary lokalne (przed skalowaniem) pierwszego mesha w GLTF - promien odciska (max szerokosc/glebokosc /2) i wysokosc, prosto z prawdziwej geometrii (patrz CLAUDE.md - accessor bbox). Liczone raz na model, cache'owane. */
    const dimsCache = new Map();
    const dims = (gltf) => {
      if (dimsCache.has(gltf)) return dimsCache.get(gltf);
      const mesh = this._firstMesh(gltf);
      mesh.geometry.computeBoundingBox();
      const b = mesh.geometry.boundingBox;
      const footprintR = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2;
      const height = b.max.y - b.min.y;
      const info = { mesh, footprintR, height };
      dimsCache.set(gltf, info);
      return info;
    };

    // Bucket per (model, castShadow) - kazdy wpis staje sie DOKLADNIE jednym
    // InstancedMesh na koniec funkcji (jak dawniej - jeden typ = jeden draw call).
    const buckets = new Map();
    const bucket = (key, gltf, castShadow) => {
      if (!buckets.has(key)) buckets.set(key, { gltf, castShadow, list: [] });
      return buckets.get(key);
    };
    /** Umieszcza rekwizyt: dobiera pozycje (near/loose), liczy footprint/wysokosc ze skala, dorzuca do odpowiedniego kubelka. facing='arena' obraca w strone centrum areny (+jitter), facing=liczba to staly kierunek (+jitter), facing=null to czysto losowy obrot. */
    const put = (key, gltf, castShadow, { center, spread, rMin, rMax, maxZ, scaleRange, facing = 'arena', jitter = 0.35, tilt = 0 }) => {
      const { footprintR, height } = dims(gltf);
      const scale = rrange(rng, scaleRange[0], scaleRange[1]);
      const spot = center
        ? placeNear(center, spread, footprintR * scale, height * scale)
        : placeLoose(rMin, rMax, footprintR * scale, height * scale, maxZ);
      if (!spot) return false;
      let ry;
      if (facing === 'arena') ry = Math.atan2(spot.x, spot.z) + Math.PI + rrange(rng, -jitter, jitter);
      else if (typeof facing === 'number') ry = facing + rrange(rng, -jitter, jitter);
      else ry = rng() * Math.PI * 2;
      bucket(key, gltf, castShadow).list.push({ x: spot.x, z: spot.z, ry, scale, tilt });
      return true;
    };

    // --- 1) Tematyczne scenki w gestym pasie MID (promien 6.6 do ~11.2), przed
    // asfaltowa obwodnica - kazda z nieregularnym srodkiem, ciasnym jadrem i
    // rzadszym "ogonem". Tematy z ciezszymi/wyzszymi elementami (targ, oboz,
    // magazyn, plac zabaw, pomost, posag) MUSZA trzymac srodek w z<=2.5, zeby
    // ich wysokie elementy nie wpadly w "strefe kamery" z>4 (patrz
    // heightOkForZ) - w praktyce ląduja wiec glownie ZA arena (widoczne w
    // kadrze kamery), a niskie tematy (ogrod/skalki/lawki) moga stanac
    // gdziekolwiek, rowniez blisko domyslnej pozycji kamery. ---
    let clustersPlaced = 0;
    let clustersSkipped = 0;
    const clusterLog = [];
    const runCluster = (name, spread, maxZ, build) => {
      const center = pickClusterCenter(MID_MIN_R, MID_MAX_R, spread, maxZ);
      if (!center) { clustersSkipped++; return; }
      const before = occupied.length;
      build(center);
      clustersPlaced++;
      clusterLog.push({ name, center, count: occupied.length - before });
    };

    // Mini-targ ze straganami (dwa, rozny rozmiar)
    runCluster('mini-targ (glowny)', 2.1, 2.5, (c) => {
      put('mFreezer', mFreezer, true, { center: c, spread: 1.5, scaleRange: [0.95, 1.05] });
      put('mFruit', mFruit, true, { center: c, spread: 1.5, scaleRange: [0.9, 1.1] });
      put('mFruit', mFruit, true, { center: c, spread: 1.6, scaleRange: [0.9, 1.1] });
      put('mBasket', mBasket, true, { center: c, spread: 1.6, scaleRange: [0.9, 1.15] });
      put('mBasket', mBasket, true, { center: c, spread: 1.7, scaleRange: [0.9, 1.15] });
      put('mCart', mCart, true, { center: c, spread: 1.6, scaleRange: [0.95, 1.05] });
      put('mBottleReturn', mBottleReturn, true, { center: c, spread: 1.7, scaleRange: [0.95, 1.05] });
    });
    runCluster('mini-targ (maly)', 1.5, 2.5, (c) => {
      put('mCart', mCart, true, { center: c, spread: 1.1, scaleRange: [0.95, 1.05] });
      put('mBasket', mBasket, true, { center: c, spread: 1.1, scaleRange: [0.9, 1.1] });
      put('mFruit', mFruit, true, { center: c, spread: 1.2, scaleRange: [0.9, 1.05] });
    });

    // Obozowisko (mini-dungeon)
    runCluster('obozowisko', 2.3, 2.5, (c) => {
      put('dWoodStruct', dWoodStruct, true, { center: c, spread: 1.4, scaleRange: [1.05, 1.2] });
      put('dWoodSupport', dWoodSupport, true, { center: c, spread: 1.6, scaleRange: [1.05, 1.2], facing: rrange(rng, 0, Math.PI * 2), jitter: 0.6 });
      put('dBarrel', dBarrel, true, { center: c, spread: 1.7, scaleRange: [1.1, 1.3] });
      put('dBarrel', dBarrel, true, { center: c, spread: 1.9, scaleRange: [1.1, 1.3] });
      put('dTable', dTable, true, { center: c, spread: 1.5, scaleRange: [1.1, 1.2] });
      put('dChair', dChair, true, { center: c, spread: 1.4, scaleRange: [1.0, 1.15] });
      put('dChair', dChair, true, { center: c, spread: 1.5, scaleRange: [1.0, 1.15] });
    });

    // Sterta skrzyn i beczek przy "magazynie" (chatka mini-forest + skrzynie/beczki pirate-kit)
    runCluster('magazyn', 2.4, 2.0, (c) => {
      // Wlasny bucket (hut-struct-near/hut-roof-near, castShadow=true) - ODDZIELNY
      // od dalekiego pierscienia chatek (hut-struct/hut-roof, castShadow=false,
      // patrz sekcja 4 nizej): ten domek stoi w pasie MID (r<=11.2, wewnatrz
      // zasiegu dir/dirWide z cieniem, patrz scene.js) i MUSI rzucac cien, w
      // odroznieniu od dalekich chatek na horyzoncie.
      const hutScale = rrange(rng, 1.1, 1.4);
      const hutRy = rng() * Math.PI * 2;
      put('hut-struct-near', bStruct, true, { center: c, spread: 0.3, scaleRange: [hutScale, hutScale], facing: hutRy, jitter: 0 });
      const hutList = buckets.get('hut-struct-near').list;
      const hutSpot = hutList[hutList.length - 1];
      bucket('hut-roof-near', bRoof, true).list.push({ x: hutSpot.x, y: 1.0 * hutScale, z: hutSpot.z, ry: hutRy, scale: hutScale });
      for (let i = 0; i < 5; i++) put('pCrate', pCrate, true, { center: c, spread: 1.9, scaleRange: [0.55, 0.7], jitter: 0.5 });
      for (let i = 0; i < 4; i++) put('pBarrel', pBarrel, true, { center: c, spread: 1.9, scaleRange: [0.5, 0.62] });
      for (let i = 0; i < 2; i++) put('dBarrel', dBarrel, true, { center: c, spread: 2.0, scaleRange: [1.0, 1.2] });
    });

    // Plac zabaw ze zwierzakami (cube-pets) - male zwierzaki, skala w dol
    // (pack ~1.5-2x wiekszy od siatki mini-* - patrz CLAUDE.md)
    runCluster('plac zabaw ze zwierzakami', 2.1, 2.5, (c) => {
      const pets = [
        ['petDog', petDog], ['petCat', petCat], ['petFox', petFox], ['petBunny', petBunny],
        ['petBee', petBee], ['petChick', petChick], ['petPig', petPig],
      ];
      for (const [key, gltf] of pets) {
        put(key, gltf, true, { center: c, spread: 1.8, scaleRange: [0.4, 0.48], facing: null });
      }
      // Powtorka dwoch gatunkow, zeby plac zabaw wygladal "zaludniony"
      put('petDog', petDog, true, { center: c, spread: 1.9, scaleRange: [0.38, 0.46], facing: null });
      put('petChick', petChick, true, { center: c, spread: 1.6, scaleRange: [0.36, 0.44], facing: null });
      put('petChick', petChick, true, { center: c, spread: 1.7, scaleRange: [0.36, 0.44], facing: null });
    });

    // Pomost przy "stawie" (mini-doki pirate-kit + beczki/skrzynie w cieniu pomostu)
    runCluster('pomost', 2.2, 2.0, (c) => {
      put('pDock', pDock, true, { center: c, spread: 0.5, scaleRange: [1.0, 1.1] });
      put('pBarrel', pBarrel, true, { center: c, spread: 1.7, scaleRange: [0.5, 0.6] });
      put('pCrate', pCrate, true, { center: c, spread: 1.7, scaleRange: [0.55, 0.65] });
      put('pGrassPlant', pGrassPlant, true, { center: c, spread: 1.8, scaleRange: [0.35, 0.45], facing: null });
      put('pGrassPlant', pGrassPlant, true, { center: c, spread: 1.9, scaleRange: [0.35, 0.45], facing: null });
    });

    // Placyk z lawkami (stol + krzesla mini-dungeon, zwrocone do srodka)
    runCluster('placyk z lawkami', 1.5, null, (c) => {
      put('dTable', dTable, true, { center: c, spread: 0.15, scaleRange: [1.05, 1.1] });
      const seatAngles = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
      for (const a of seatAngles) {
        const dist = 0.75;
        const x = c.x + Math.sin(a) * dist;
        const z = c.z + Math.cos(a) * dist;
        const { footprintR, height } = dims(dChair);
        const scale = rrange(rng, 1.0, 1.1);
        if (zoneBlocked(x, z, footprintR * scale) || overlapsOccupied(x, z, footprintR * scale) || !heightOkForZ(z, height * scale)) continue;
        occupied.push({ x, z, r: footprintR * scale });
        bucket('dChair', dChair, true).list.push({ x, z, ry: a + Math.PI + rrange(rng, -0.1, 0.1), scale });
      }
    });

    // Kacik ogrodnika (x2) - rosliny/kamienie/kepki, nisko, moze stanac wszedzie
    for (const name of ['kacik ogrodnika A', 'kacik ogrodnika B']) {
      runCluster(name, 1.7, null, (c) => {
        for (let i = 0; i < 5; i++) put('plant', plant, true, { center: c, spread: 1.5, scaleRange: [0.9, 1.3], facing: null });
        for (let i = 0; i < 3; i++) put('patchGrassMid', patchGrass, true, { center: c, spread: 1.6, scaleRange: [1.0, 1.4], facing: null });
        for (let i = 0; i < 2; i++) put('stones', stones, true, { center: c, spread: 1.6, scaleRange: [0.8, 1.1], facing: null });
      });
    }

    // Rumowisko skal (x2) - nisko, moze stanac wszedzie
    for (const name of ['rumowisko skal A', 'rumowisko skal B']) {
      runCluster(name, 1.9, null, (c) => {
        for (let i = 0; i < 4; i++) put('rocksHighMid', rocksHigh, true, { center: c, spread: 1.7, scaleRange: [0.7, 1.0], facing: null });
        for (let i = 0; i < 5; i++) put('rocksLowMid', rocksLow, true, { center: c, spread: 1.8, scaleRange: [0.7, 1.05], facing: null });
        for (let i = 0; i < 4; i++) put('stones', stones, true, { center: c, spread: 1.8, scaleRange: [0.8, 1.15], facing: null });
      });
    }

    // Pomnik/sztandar (mini-arena) - akcent, tylko jeden
    runCluster('pomnik', 1.4, 2.5, (c) => {
      put('aStatue', aStatue, true, { center: c, spread: 0.2, scaleRange: [1.0, 1.0] });
      put('aBanner', aBanner, true, { center: c, spread: 0.9, scaleRange: [0.95, 1.05] });
    });

    // --- 2) Pojedyncze rekwizyty rozrzucone MIEDZY scenkami w tym samym pasie
    // MID (6.6-11.2) - wypelniaja puste trawniki, ktore scenki zostawily. ---
    const MID_SINGLES = [
      { key: 'plant', gltf: plant, count: 40, scaleRange: [0.75, 1.25] },
      { key: 'rocksLowMid', gltf: rocksLow, count: 20, scaleRange: [0.7, 1.05] },
      { key: 'rocksHighMid', gltf: rocksHigh, count: 16, scaleRange: [0.7, 1.0] },
      { key: 'stones', gltf: stones, count: 20, scaleRange: [0.8, 1.2] },
      { key: 'patchGrassMid', gltf: patchGrass, count: 36, scaleRange: [0.85, 1.3] },
      { key: 'patchDirtMid', gltf: patchDirt, count: 20, scaleRange: [0.9, 1.3] },
      { key: 'pGrass', gltf: pGrass, count: 70, scaleRange: [0.35, 0.55] },
      { key: 'pGrassPlant', gltf: pGrassPlant, count: 22, scaleRange: [0.3, 0.42] },
      { key: 'pGrassFoliage', gltf: pGrassFoliage, count: 14, scaleRange: [0.16, 0.22] },
      { key: 'dBarrel', gltf: dBarrel, count: 9, scaleRange: [1.0, 1.2] },
      { key: 'pCrate', gltf: pCrate, count: 9, scaleRange: [0.5, 0.62] },
      { key: 'fenceMid', gltf: fence, count: 7, scaleRange: [0.9, 1.05] },
    ];
    let singlesPlaced = 0;
    for (const def of MID_SINGLES) {
      for (let i = 0; i < def.count; i++) {
        if (put(def.key, def.gltf, true, { rMin: MID_MIN_R, rMax: MID_MAX_R, scaleRange: def.scaleRange, facing: null })) singlesPlaced++;
      }
    }

    // --- 3) Kepki trawy/gruntu wprost na placu (za plotkiem areny, przed
    // kamiennymi sciezkami) - ta sama logika co dawniej (4 kamienne sciezki
    // biegna pod katami 0/90/180/270 - omijamy je +-18 stopni), tylko na
    // seedowanym PRNG zamiast Math.random(), zeby CALE przedpole bylo
    // powtarzalne. ---
    const plazaClutterDefs = [
      { key: 'patchGrassPlaza', gltf: patchGrass, count: 26, scaleRange: [0.8, 1.2], radius: [4.4, 6.2], nearPaths: false },
      { key: 'patchDirtPlaza', gltf: patchDirt, count: 14, scaleRange: [0.9, 1.3], radius: [4.5, 6.0], nearPaths: true },
    ];
    for (const def of plazaClutterDefs) {
      const { footprintR, height } = dims(def.gltf);
      let placed = 0;
      let guard = 0;
      while (placed < def.count && guard < def.count * 25) {
        guard++;
        attempts++;
        const angle = rng() * Math.PI * 2;
        const deg = (angle * 180) / Math.PI;
        const angDist = (a) => Math.abs(((deg - a + 540) % 360) - 180);
        const nearAxis = [0, 90, 180, 270].some((a) => angDist(a) <= 18);
        if (def.nearPaths !== nearAxis) { rejections++; continue; }
        const radius = rrange(rng, def.radius[0], def.radius[1]);
        const scale = rrange(rng, def.scaleRange[0], def.scaleRange[1]);
        const x = Math.sin(angle) * radius;
        const z = Math.cos(angle) * radius;
        const r = footprintR * scale;
        if (overlapsOccupied(x, z, r) || !heightOkForZ(z, height * scale)) { rejections++; continue; }
        occupied.push({ x, z, r });
        bucket(def.key, def.gltf, true).list.push({ x, z, ry: rng() * Math.PI * 2, scale });
        placed++;
      }
    }

    // --- 4) Daleki pas (13.7 do 18.7, za obwodnica): nieregularnie rozrzucona
    // zielen/zabudowa (dawniej: idealny pierscien slotow co 360/26 stopni) +
    // rzadkie pojedyncze skalki/krzaki. castShadow=false na calym pasie - poza
    // zasiegiem swiatel z cieniem (patrz uzasadnienie przy TALL_TYPES nizej w
    // oryginalnym kodzie / raport zadania), a jednoczesnie ZAWSZE z<=4 nie
    // jest wymagane tutaj (te obiekty sa daleko od domyslnej pozycji kamery,
    // nawet gdy z>4 - patrz uzasadnienie CAMERA_NEAR_Z powyzej), wiec ida
    // przez wlasna, prostsza funkcje rejection-samplingu bez ograniczenia z. */
    const farOccupied = []; // oddzielna lista - pas daleki nie koliduje z pasem MID (dzieli je cala obwodnica)
    const placeFar = (footprintR, tries = 40) => {
      for (let i = 0; i < tries; i++) {
        attempts++;
        const angle = rng() * Math.PI * 2;
        const radius = rrange(rng, FAR_MIN_R, FAR_MAX_R);
        const x = Math.sin(angle) * radius;
        const z = Math.cos(angle) * radius;
        if (farOccupied.some((o) => Math.hypot(x - o.x, z - o.z) < o.r + footprintR + 0.06)) { rejections++; continue; }
        farOccupied.push({ x, z, r: footprintR });
        return { x, z };
      }
      rejections++;
      return null;
    };
    const putFar = (key, gltf, { scaleRange, extraY = 0 }) => {
      const { footprintR, height } = dims(gltf);
      const scale = rrange(rng, scaleRange[0], scaleRange[1]);
      const spot = placeFar(footprintR * scale);
      if (!spot) return null;
      const ry = rng() * Math.PI * 2;
      bucket(key, gltf, false).list.push({ x: spot.x, y: extraY * scale, z: spot.z, ry, scale });
      return spot;
    };
    const FAR_TYPES = [
      ['tree', tree, [0.85, 1.25], 11],
      ['treeHigh', treeHigh, [0.85, 1.2], 7],
      ['tower', pTower, [0.85, 1.05], 7],
      ['structure', pStructure, [1.0, 1.3], 7],
      ['palmStraight', pPalmStraight, [0.5, 0.65], 6],
      ['palmBend', pPalmBend, [0.5, 0.62], 5],
      ['flag', pFlag, [0.6, 0.7], 3],
    ];
    for (const [key, gltf, scaleRange, count] of FAR_TYPES) {
      for (let i = 0; i < count; i++) putFar(key, gltf, { scaleRange });
    }
    const FAR_HUT_COUNT = 7;
    for (let i = 0; i < FAR_HUT_COUNT; i++) {
      const scale = rrange(rng, 1.0, 1.6);
      const spot = placeFar(dims(bStruct).footprintR * scale);
      if (!spot) continue;
      const ry = rng() * Math.PI * 2;
      bucket('hut-struct', bStruct, false).list.push({ x: spot.x, z: spot.z, ry, scale });
      bucket('hut-roof', bRoof, false).list.push({ x: spot.x, y: 1.0 * scale, z: spot.z, ry, scale });
    }
    const FAR_SINGLES = [
      ['rocksHighFar', rocksHigh, [0.7, 1.0], 14],
      ['rocksLowFar', rocksLow, [0.7, 1.05], 14],
      ['stonesFar', stones, [0.8, 1.2], 14],
      ['pGrassPlantFar', pGrassPlant, [0.3, 0.45], 18],
      ['pGrassFoliageFar', pGrassFoliage, [0.16, 0.24], 10],
    ];
    for (const [key, gltf, scaleRange, count] of FAR_SINGLES) {
      for (let i = 0; i < count; i++) putFar(key, gltf, { scaleRange });
    }

    // --- 5) Ozdobny plotek na krawedzi placu (promien 8.75) - zostaje PELNYM
    // pierscieniem (to fizyczna granica/ogrodzenie miedzy plazą a dzikszym
    // terenem apronu, nie "rozrzucony rekwizyt" - patrz raport zadania). ---
    {
      const { footprintR, height } = dims(fence);
      const list = [];
      for (let i = 0; i < FOREGROUND_SLOTS; i++) {
        const angle = (i / FOREGROUND_SLOTS) * Math.PI * 2;
        const radius = FOREGROUND_LOW_MAX + 0.15;
        const x = Math.sin(angle) * radius;
        const z = Math.cos(angle) * radius;
        list.push({ x, z, ry: angle, scale: rrange(rng, 0.95, 1.05) });
        occupied.push({ x, z, r: footprintR });
      }
      bucket('fenceRing', fence, true).list.push(...list);
    }

    // --- 6) Kolumny z mini-arcade jako pilastry przy kilku dalekich "domkach" ---
    {
      const columnCount = 6;
      const list = [];
      for (let i = 0; i < columnCount; i++) {
        const angle = rrange(rng, 0, Math.PI * 2);
        const radius = rrange(rng, FAR_MIN_R + 0.1, FAR_MIN_R + 1.2);
        const x = Math.sin(angle) * radius;
        const z = Math.cos(angle) * radius;
        const perp = angle + Math.PI / 2;
        for (const sign of [-1, 1]) {
          list.push({ x: x + Math.sin(perp) * 0.55 * sign, z: z + Math.cos(perp) * 0.55 * sign, ry: angle, scale: 1 });
        }
      }
      bucket('column', columnGltf, false).list.push(...list);
    }

    // --- Materializacja: kazdy kubelek -> jeden InstancedMesh (jeden draw call
    // niezaleznie od liczby instancji w nim). ---
    const meshes = [];
    for (const [, { gltf, castShadow, list }] of buckets) {
      if (list.length === 0) continue;
      const mesh = this._firstMesh(gltf);
      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length);
      inst.castShadow = castShadow;
      inst.receiveShadow = castShadow;
      inst.frustumCulled = false;
      list.forEach((p, i) => {
        dummy.position.set(p.x, p.y || 0, p.z);
        dummy.rotation.set(0, p.ry || 0, 0);
        dummy.scale.setScalar(p.scale != null ? p.scale : 1);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      scene.add(inst);
      meshes.push(inst);
    }
    this.foregroundMeshes = meshes;

    const totalInstances = [...buckets.values()].reduce((n, b) => n + b.list.length, 0);
    console.info(
      `[city] Przedpole: ${clustersPlaced} scenek (${clustersSkipped} pominietych - brak miejsca), `
      + `${singlesPlaced}/${MID_SINGLES.reduce((n, d) => n + d.count, 0)} pojedynczych rekwizytow w pasie glownym, `
      + `${totalInstances} instancji lacznie w ${buckets.size} draw callach, `
      + `${attempts} prob losowania pozycji (${rejections} odrzuconych, ${((rejections / Math.max(1, attempts)) * 100).toFixed(0)}%).`,
    );
    this._foregroundClusterLog = clusterLog;
  }

  // --- Plac pod arena - jedna bryla betonu (cokol), wierzch na y=PLAZA_TOP_Y
  // przykryty cienka nakladka z trawa+sciezkami (patrz nizej) ---
  _buildPlaza(scene, renderer) {
    const geo = new THREE.BoxGeometry(PLAZA_HALF * 2, PLAZA_HEIGHT, PLAZA_HALF * 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x20242f, roughness: 0.95, metalness: 0.05 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, CITY_GROUND_Y + PLAZA_HEIGHT / 2, 0);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    scene.add(mesh);
    this.plazaMesh = mesh;

    // Nakladka z trawa+przetarta ziemia+kamienne sciezki (createPlazaGroundTexture)
    // - cienka plaszczyzna 0.005 j. NAD betonowym cokolem (PLAZA_TOP_Y=-0.02),
    // wciaz WYRAZNIE ponizej wierzchu kafli podlogi areny (y=0) - zero
    // wspolplaszczyznowosci z ktorymkolwiek z tych dwoch poziomow. Boczne
    // sciany cokolu zostaja bez tekstury (material box'a niezmieniony), wiec
    // plac nadal wyglada jak podniesiony betonowy postument z zielonym
    // "dywanem" na wierzchu, a nie jednolita bryla trawy.
    const plazaTopY = CITY_GROUND_Y + PLAZA_HEIGHT; // = PLAZA_TOP_Y
    const overlayGeo = new THREE.PlaneGeometry(PLAZA_HALF * 2, PLAZA_HALF * 2);
    const overlayTex = createPlazaGroundTexture();
    applyTextureFiltering(overlayTex, renderer);
    const overlayMat = new THREE.MeshStandardMaterial({ map: overlayTex, roughness: 1, metalness: 0 });
    const overlay = new THREE.Mesh(overlayGeo, overlayMat);
    overlay.rotation.x = -Math.PI / 2;
    overlay.position.set(0, plazaTopY + 0.005, 0);
    overlay.receiveShadow = true;
    scene.add(overlay);
    this.plazaGroundOverlay = overlay;

    // Cienki pasek na krawedzi placu, tuz PONIZEJ wierzchu placu.
    // Uwaga (naprawa Z-fightingu): pasek jest szerszy od placu tylko o 0.06, wiec
    // jego gorna sciana lezy nad CALA powierzchnia placu. Gdy obie byly na
    // dokladnie tej samej wysokosci (y = 0), caly plac wokol areny migotal przy
    // ruchu kamery - dwie nieprzezroczyste, wspolplaszczyznowe sciany walczyly
    // o glebie. Zepchniecie paska o EDGE_DROP w dol usuwa konflikt, a widoczna
    // z gory pozostaje dokladnie ta obwodka, o ktora chodzilo.
    // Kolor zmieniony z jaskrawego neonowego zielonego (0x53fc18, nocny akcent
    // Kicka, mial byc "sprzedany" przez selektywny bloom) na stonowany, cieply
    // kamienny bezowy - w pelnym sloncu, bez blooma (usuniety, patrz main.js),
    // czysty neon-zielony wygladalby jak wymalowana linia farby, nie
    // krawedz/obrzeze postumentu.
    const EDGE_DROP = 0.012;
    const edgeGeo = new THREE.BoxGeometry(PLAZA_HALF * 2 + 0.06, 0.06, PLAZA_HALF * 2 + 0.06);
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0x9a8f7c, roughness: 0.9, metalness: 0.05 });
    const edge = new THREE.Mesh(edgeGeo, edgeMat);
    edge.position.set(0, CITY_GROUND_Y + PLAZA_HEIGHT - 0.03 - EDGE_DROP, 0);
    edge.castShadow = false;
    edge.receiveShadow = true;
    scene.add(edge);
    this.plazaEdgeMesh = edge;
  }

  // --- Podloze miasta - wielka plaszczyzna z tekstura ulic ---
  _buildStreetGround(scene) {
    const tex = createStreetTexture();
    const geo = new THREE.PlaneGeometry(CITY_HALF * 2 + 20, CITY_HALF * 2 + 20);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, CITY_GROUND_Y, 0);
    // Ta plaszczyzna siega od krawedzi apronu (19.3) az do CITY_HALF*2+20=108 -
    // niemal cala jej powierzchnia lezy poza zasiegiem obu swiatel z cieniem
    // (r<=13.5, patrz scene.js), a czesc blisko areny i tak jest przykryta
    // apronem (ktory MA receiveShadow=true) stojacym nad nia. receiveShadow
    // tu byloby wiec czystym kosztem (probkowanie mapy cienia na ogromnym
    // obszarze ekranu przy szerokich ujeciach) bez zadnego widocznego efektu.
    mesh.receiveShadow = false;
    scene.add(mesh);
    this.groundMesh = mesh;
  }

  // --- Budynki: jeden InstancedMesh (bryly) + jeden InstancedMesh (neonowe akcenty na dachach) ---
  _buildBuildings(scene, renderer) {
    const windowTex = createWindowTexture();
    applyTextureFiltering(windowTex, renderer);
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveMap: windowTex,
      // Dawniej 0.42 (symulowaly "zapalone" okna nocnego miasta). W dzien
      // okna NIE moga swiecic jak w nocy (wymaganie zadania) - budynki sa
      // teraz oswietlane WYLACZNIE realnym slonce+niebo (dir/hemi w scene.js),
      // a windowTex nadal daje wizualna teksture podzialu na okna (poprzez
      // sam kolor/kontrast bodyPalette), tylko bez wlasnej emisji swiatla.
      // Bardzo niska (nie zero) resztkowa wartosc - delikatny refleks szyby,
      // nie realne swiecenie.
      emissiveIntensity: 0.03,
      roughness: 0.85,
      metalness: 0.1,
      vertexColors: true,
    });

    // Policz ile dzialek faktycznie spelnia warunek keepout, zeby InstancedMesh mial dokladny rozmiar
    const cells = [];
    for (let gx = -CITY_HALF; gx <= CITY_HALF; gx += BUILDING_GRID) {
      if (gx === 0) continue;
      for (let gz = -CITY_HALF; gz <= CITY_HALF; gz += BUILDING_GRID) {
        if (gz === 0) continue;
        if (Math.hypot(gx, gz) < BUILDING_KEEPOUT_RADIUS) continue;
        cells.push({ x: gx, z: gz });
      }
    }

    const count = cells.length;
    const buildingMesh = new THREE.InstancedMesh(boxGeo, bodyMat, count);
    // Budynki miasta stoja od promienia BUILDING_KEEPOUT_RADIUS=26 w gore -
    // daleko poza zasiegiem obu swiatel z cieniem (dir/dirWide w scene.js,
    // r<=13.5). Wlasciciel wprost zazyczyl sobie braku cienia na dalekiej
    // zabudowie miasta - i to jednoczesnie spory zysk wydajnosci, bo to
    // najwieksza pojedyncza grupa instancji w calej scenie (patrz raport
    // zadania, liczby przed/po).
    buildingMesh.castShadow = false;
    buildingMesh.receiveShadow = false;
    // InstancedMesh liczy domyslna kule odciecia (frustum culling) wokol
    // lokalnego originu geometrii bazowej, IGNORUJAC rozrzucenie instancji
    // przez ich wlasne macierze - przy budynkach rozrzuconych na promieniu
    // do CITY_HALF to obcina caly InstancedMesh naraz, gdy kamera nie patrzy
    // wprost na (0,0,0). Wylaczamy odciecie - liczba instancji jest mala,
    // koszt pominiecia CPU-side culling jest pomijalny.
    buildingMesh.frustumCulled = false;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    // Paleta rozjasniona wzgledem nocnej wersji (byla niemal czarno-granatowo-
    // fioletowa, dobrana pod sylwetki na tle ciemnego nieba) - w dzien budynki
    // pokazuja swoj rzeczywisty kolor w swietle slonca, wiec dostaja
    // stonowane, jasniejsze betonowo/piaskowe/szklane tony pasujace do
    // dziennego nieba i mgly (patrz scene.js/FOG_* powyzej).
    const bodyPalette = [0x8d93a1, 0x9aa0ac, 0x8b7f6f, 0x8996a6, 0xa4967f];

    // Dawniej "neonowe szyldy" (paleta czystych, nasyconych barw - zielony/
    // rozowy/blekit/zolty/czerwony - mial je "sprzedawac" selektywny bloom,
    // patrz usuniety BLOOM_LAYER/main.js). W dzien, bez blooma, czytaja sie
    // teraz jako zwykle, przygaszone akcenty dachowe (klimatyzatory/zbiorniki/
    // anteny) - ta sama geometria/rola w scenie, ale STONOWANA paleta zamiast
    // czystych, jaskrawych barw.
    const neonCount = Math.max(1, Math.round(count * 0.08));
    const neonMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
    const neonMesh = new THREE.InstancedMesh(boxGeo, neonMat, neonCount);
    neonMesh.frustumCulled = false;
    const neonPalette = [0x5c6b58, 0x7a5c68, 0x5c6b74, 0x9c8f66, 0x8a6058];
    let neonIdx = 0;

    // Miasto ma czytac sie jako TLO za scianami areny - dalsze budynki wyzsze
    // i lekko przyciemnione (wtapiaja sie w mgle), blizsze nizsze, zeby nie
    // zaslanialy sylwetki i nie tworzyly "sciany" tuz za arena. t=0 na
    // granicy keepout, t=1 w najdalszym rogu miasta (przekatna CITY_HALF).
    const maxDist = Math.SQRT2 * CITY_HALF;

    for (let i = 0; i < count; i++) {
      const { x, z } = cells[i];
      const dist = Math.hypot(x, z);
      const t = THREE.MathUtils.clamp((dist - BUILDING_KEEPOUT_RADIUS) / (maxDist - BUILDING_KEEPOUT_RADIUS), 0, 1);
      // Szansa na wiezowiec i gorny zakres wysokosci rosna z odlegloscia -
      // blisko areny tylko kameralna, niska zabudowa (~4% szans na wysoki
      // budynek), przy krawedzi miasta wiezowce sa czeste (~32%) i wyzsze.
      const tallChance = 0.04 + t * 0.28;
      const height = Math.random() < tallChance
        ? randRange(6, 9 + t * 6)
        : randRange(1.8, 3.2 + t * 2.5);
      const footprint = BUILDING_FOOTPRINT * randRange(0.85, 1.15);

      dummy.position.set(x + randRange(-0.3, 0.3), CITY_GROUND_Y + height / 2, z + randRange(-0.3, 0.3));
      dummy.scale.set(footprint, height, footprint);
      dummy.rotation.y = randRange(0, Math.PI * 2);
      dummy.updateMatrix();
      buildingMesh.setMatrixAt(i, dummy.matrix);

      // Delikatne przyciemnienie z odlegloscia (depth cueing) - pomaga
      // dalekim budynkom wtopic sie w mgle zamiast urywac sie ostro na
      // granicy FOG_FAR, dodatkowo tlumi kontrast calej panoramy.
      color.setHex(bodyPalette[Math.floor(Math.random() * bodyPalette.length)]);
      color.multiplyScalar(1 - t * 0.35);
      buildingMesh.setColorAt(i, color);

      // Co ~1 na 12 budynkow dostaje neonowy szyld na dachu
      if (Math.random() < 0.08 && neonIdx < neonCount) {
        dummy.position.set(x, CITY_GROUND_Y + height + 0.35, z);
        dummy.scale.set(footprint * 0.6, 0.5, 0.12);
        dummy.rotation.y = randRange(0, Math.PI * 2);
        dummy.updateMatrix();
        neonMesh.setMatrixAt(neonIdx, dummy.matrix);
        color.setHex(neonPalette[Math.floor(Math.random() * neonPalette.length)]);
        neonMesh.setColorAt(neonIdx, color);
        neonIdx++;
      }
    }
    // Ewentualne niewykorzystane sloty neonu - schowaj poza scena (skala 0)
    for (let i = neonIdx; i < neonCount; i++) {
      dummy.position.set(0, -1000, 0);
      dummy.scale.set(0.0001, 0.0001, 0.0001);
      dummy.updateMatrix();
      neonMesh.setMatrixAt(i, dummy.matrix);
    }

    buildingMesh.instanceMatrix.needsUpdate = true;
    if (buildingMesh.instanceColor) buildingMesh.instanceColor.needsUpdate = true;
    neonMesh.instanceMatrix.needsUpdate = true;
    if (neonMesh.instanceColor) neonMesh.instanceColor.needsUpdate = true;

    scene.add(buildingMesh);
    scene.add(neonMesh);
    this.buildingMesh = buildingMesh;
    this.neonMesh = neonMesh;
  }

  // --- Samochody: 3 InstancedMesh (nadwozie, przednie swiatla, tylne swiatla), ruch w update() ---
  _buildCars(scene) {
    const total = LOOP_HALF_SIZES.length * CARS_PER_LOOP;
    const bodyGeo = new THREE.BoxGeometry(0.42, 0.24, 0.78);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.5,
      metalness: 0.3,
    });
    const bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, total);
    bodyMesh.frustumCulled = false;

    const lightGeo = new THREE.BoxGeometry(0.34, 0.08, 0.06);
    const frontMat = new THREE.MeshBasicMaterial({ color: 0xfff3c0 });
    const rearMat = new THREE.MeshBasicMaterial({ color: 0xff3030 });
    const frontMesh = new THREE.InstancedMesh(lightGeo, frontMat, total);
    frontMesh.frustumCulled = false;
    const rearMesh = new THREE.InstancedMesh(lightGeo, rearMat, total);
    rearMesh.frustumCulled = false;

    const color = new THREE.Color();
    this.cars = [];
    let idx = 0;
    for (const halfSize of LOOP_HALF_SIZES) {
      const perim = halfSize * 8;
      for (let i = 0; i < CARS_PER_LOOP; i++) {
        this.cars.push({
          loopHalf: halfSize,
          progress: (perim / CARS_PER_LOOP) * i + randRange(0, 1.5),
          speed: randRange(1.4, 3.2),
          colorHex: CAR_COLORS[idx % CAR_COLORS.length],
        });
        color.setHex(CAR_COLORS[idx % CAR_COLORS.length]);
        bodyMesh.setColorAt(idx, color);
        idx++;
      }
    }
    if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;

    // Swiatla aut (przednie/tylne) - male, kolorowe (bez emisji swiatla)
    // powierzchnie zderzaka/lamp, widoczne w dzien jako zwykly detal
    // karoserii (dawny selektywny bloom na tej warstwie - usuniety, patrz
    // main.js/raport zadania).
    scene.add(bodyMesh);
    scene.add(frontMesh);
    scene.add(rearMesh);
    this.carBodyMesh = bodyMesh;
    this.carFrontLightMesh = frontMesh;
    this.carRearLightMesh = rearMesh;

    // Pierwsza pozycja natychmiast, zeby auta nie "skakaly" z (0,0,0) w pierwszej klatce
    this.update(0);
  }

  /** Aktualizuje ruch wszystkich samochodow po petlach ulic. Zero alokacji na klatke. */
  update(delta) {
    if (!this.carBodyMesh) return;
    const dummy = this._dummy;
    const pt = this._pt;
    const carY = CITY_GROUND_Y + 0.16;

    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      car.progress += car.speed * delta;

      pointOnLoop(car.loopHalf, car.progress, pt);
      const fx = Math.sin(pt.heading);
      const fz = Math.cos(pt.heading);

      dummy.position.set(pt.x, carY, pt.z);
      dummy.rotation.set(0, pt.heading, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      this.carBodyMesh.setMatrixAt(i, dummy.matrix);

      dummy.position.set(pt.x + fx * 0.36, carY, pt.z + fz * 0.36);
      dummy.updateMatrix();
      this.carFrontLightMesh.setMatrixAt(i, dummy.matrix);

      dummy.position.set(pt.x - fx * 0.36, carY, pt.z - fz * 0.36);
      dummy.updateMatrix();
      this.carRearLightMesh.setMatrixAt(i, dummy.matrix);
    }

    this.carBodyMesh.instanceMatrix.needsUpdate = true;
    this.carFrontLightMesh.instanceMatrix.needsUpdate = true;
    this.carRearLightMesh.instanceMatrix.needsUpdate = true;
  }
}
