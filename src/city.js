import * as THREE from 'three';
import { loadForest, loadArcade, loadDungeon, loadPirate, loadArena } from './assets.js';

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
// z maxDistance=8.5, wiec teoretyczny najdalszy promien kamery od (0,0,0) to
// ~8.5 + |target| ~= 9.16 j. Niskie elementy (krzaki/kamienie, <0.6 j.) sa
// bezpieczne w kazdej odleglosci - nie siegaja wysokosci kamery/glowy postaci.
// WYSOKIE elementy (drzewa/budynki) MUSZA staC poza tym promieniem, inaczej w
// jakims kacie kamery znajda sie miedzy kamera a arena i zaslonia rozgrywke.
const FOREGROUND_APRON_HALF = 10.5; // polowa boku zielonego "trawnika" rozszerzajacego plac
const FOREGROUND_LOW_MIN = 6.7; // tuz za krawedzia oryginalnego placu (6.5)
const FOREGROUND_LOW_MAX = 8.6; // niska zielen - bezpieczna wszedzie
const FOREGROUND_TALL_MIN = 9.4; // margines bezpieczenstwa ponad teoretyczne 9.16
const FOREGROUND_TALL_MAX = 10.3; // w granicach apronu (10.5)
const FOREGROUND_SLOTS = 26; // rozstaw katowy - "skomponowane" sloty, nie czysty losowy rozrzut

const CITY_HALF = 34; // zasieg miasta (budynki/ulice) od centrum
const BUILDING_GRID = 4; // rozstaw siatki dzialek budynkow
// Wolna strefa (promien od centrum sceny) bez budynkow. OrbitControls
// (patrz scene.js) pozwala kamerze oddalic sie do maxDistance = 8.5 od celu
// blisko origin - promien MUSI miec wyrazny margines ponad to, inaczej
// wysoki budynek staje tuz przy kamerze i zaslania cala scene (zmierzone
// empirycznie - przy promieniu 10 tak sie wlasnie dzialo).
const BUILDING_KEEPOUT_RADIUS = 16;
const BUILDING_FOOTPRINT = 2.3; // szerokosc/glebokosc dzialki budynku (mniejsza niz rozstaw siatki - zostaw ulice)

const LOOP_HALF_SIZES = [15, 19, 23, 27]; // promienie petli ulic (samochody krazą po obwodzie prostokata) - poza zasiegiem kamery
const CARS_PER_LOOP = 10;

// Mgla MUSI zaczynac sie poza najdalszym mozliwym punktem areny od kamery -
// przy maxDistance=8.5 (OrbitControls) i promieniu areny ~5 od celu, w
// skrajnym ustawieniu kamery to nawet ~13.5 jednostki (zmierzone empirycznie
// jako bezpieczny margines). FOG_NEAR=14 trzyma arene i postacie zawsze
// calkowicie poza zasiegiem mgly.
const FOG_NEAR = 14;
// Zmniejszone z 65 - rog miasta (przekatna CITY_HALF*sqrt2 ~= 48) ledwo
// dotykal starej granicy mgly, wiec daleka zabudowa nie rozmywala sie
// wystarczajaco i dokladala sie do "sciany szumu" w gornej polowie kadru.
// Przy 50 najdalsze budynki (za keepout radius 16) sa juz wyraznie
// wtopione we mgle, arena (poza zasiegiem FOG_NEAR=14) nadal nietknieta.
const FOG_FAR = 50;

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Generuje raz teksture "okien" budynku na canvasie - siatka przygaszonych
 * kwadracikow na ciemnogranatowym tle.
 *
 * Zmierzony problem (zrzuty z domyslnego kadru): przy siatce 6x12 i
 * tex.repeat.set(2,5) na ekranie wychodzilo 12x60 okien na sciane, a budynki
 * stoja 16-34 jednostki od kamery (FOV 42) - pojedyncze okno wypadalo ponizej
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

  // Jasne, swiecace pasy jezdni na krzyz (siatka ulic)
  ctx.strokeStyle = 'rgba(255, 214, 110, 0.85)';
  ctx.lineWidth = 5;
  ctx.shadowColor = '#ffb347';
  ctx.shadowBlur = 12;
  ctx.setLineDash([26, 18]);
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2, 0);
  ctx.lineTo(canvas.width / 2, canvas.height);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, canvas.height / 2);
  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();

  // Neonowo-zielona krawedz Kicka wzdluz brzegow kafla (swiecaca krawedz ulicy)
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(83, 252, 24, 0.35)';
  ctx.lineWidth = 6;
  ctx.shadowColor = '#53fc18';
  ctx.shadowBlur = 8;
  ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(CITY_HALF, CITY_HALF);
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
    // Mgla dopasowana do koloru tla (0x0e1118) - odlegle budynki rozmywaja sie
    // plynnie zamiast urywac sie ostra krawedzia. near/far dobrane tak, zeby
    // arena (w promieniu ~8.5 od kamery, patrz OrbitControls.maxDistance w
    // scene.js) zostala CALKOWICIE poza zasiegiem mgly.
    scene.fog = new THREE.Fog(0x0e1118, FOG_NEAR, FOG_FAR);

    this._buildPlaza(scene);
    this._buildStreetGround(scene);
    this._buildBuildings(scene, renderer);
    this._buildCars(scene);
    this._buildForegroundApron(scene);
    // Asynchroniczne (GLB) - leci w tle, nie blokuje pierwszej klatki. Ewentualny
    // blad sieci/ladowania jest logowany, ale NIE wywraca reszty gry (patrz
    // main.js - city.build() nigdy nie jest await-owane).
    this._buildForegroundProps(scene, renderer).catch((err) => {
      console.error('[city] Nie udalo sie zbudowac foregroundu (drzewa/budynki):', err);
    });
  }

  // --- Zielony "apron" - lekko obnizone (o 0.005, zero Z-fightingu z placem)
  // rozszerzenie placu, na ktorym stoi caly zielono-miejski foreground. ---
  _buildForegroundApron(scene) {
    const geo = new THREE.BoxGeometry(FOREGROUND_APRON_HALF * 2, PLAZA_HEIGHT, FOREGROUND_APRON_HALF * 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1c2a1e, roughness: 1, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, CITY_GROUND_Y + PLAZA_HEIGHT / 2 - 0.005, 0);
    mesh.receiveShadow = true;
    scene.add(mesh);
    this.foregroundApronMesh = mesh;
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
      dWoodStruct, dWoodSupport, dBarrel, dTable,
    ] = await Promise.all([
      loadForest('tree'), loadForest('tree-high'), loadForest('plant'),
      loadForest('rocks-high'), loadForest('rocks-low'), loadForest('stones'),
      loadForest('fence'), loadForest('building-structure'), loadForest('building-roof'),
      loadPirate('tower-watch'), loadPirate('structure'), loadPirate('palm-detailed-straight'),
      loadPirate('palm-bend'), loadPirate('flag-high-pennant'), loadPirate('barrel'), loadPirate('crate'),
      loadArena('statue'), loadArena('banner'),
      loadArcade('display-fruit'), loadArcade('shopping-cart'), loadArcade('shopping-basket'),
      loadArcade('freezers-standing'), loadArcade('bottle-return'),
      loadDungeon('wood-structure'), loadDungeon('wood-support'), loadDungeon('barrel'), loadDungeon('table'),
    ]);

    const dummy = new THREE.Object3D();

    /** Umieszcza pojedynczy InstancedMesh z podanej listy transformacji (pos/rot/scale). */
    const makeInstanced = (gltf, placements) => {
      const mesh = this._firstMesh(gltf);
      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, Math.max(1, placements.length));
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      placements.forEach((p, i) => {
        dummy.position.set(p.x, p.y || 0, p.z);
        dummy.rotation.set(0, p.ry || 0, 0);
        dummy.scale.setScalar(p.scale != null ? p.scale : 1);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      scene.add(inst);
      return inst;
    };

    /** Zwraca (x,z) na okregu wokol anchor (angle,radius) przesuniete lokalnie
     * o offsetRadial (wzdluz promienia, od centrum areny) i offsetTangent
     * (stycznie, wzdluz okregu) - pozwala ulozyc kilka rekwizytow obok siebie
     * jako spojny "zestaw" (np. stragan + wozek + skrzynie), zamiast czysto
     * losowego rozrzutu. */
    const clusterXZ = (angle, radius, offsetRadial = 0, offsetTangent = 0) => ({
      x: Math.sin(angle) * radius + Math.sin(angle) * offsetRadial + Math.cos(angle) * offsetTangent,
      z: Math.cos(angle) * radius + Math.cos(angle) * offsetRadial - Math.sin(angle) * offsetTangent,
    });

    // --- Niska zielen (promien 6.7-8.6): rosliny, kamienie, ogrodzenia ---
    const lowDefs = [
      { gltf: plant, count: 22, scaleRange: [0.8, 1.3] },
      { gltf: rocksLow, count: 10, scaleRange: [0.7, 1.1] },
      { gltf: rocksHigh, count: 8, scaleRange: [0.7, 1.0] },
      { gltf: stones, count: 10, scaleRange: [0.8, 1.2] },
      { gltf: fence, count: FOREGROUND_SLOTS, scaleRange: [0.95, 1.05], tangential: true },
    ];
    for (const def of lowDefs) {
      const mesh = this._firstMesh(def.gltf);
      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, def.count);
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      for (let i = 0; i < def.count; i++) {
        const angle = def.tangential
          ? (i / def.count) * Math.PI * 2
          : randRange(0, Math.PI * 2);
        const radius = def.tangential
          ? FOREGROUND_LOW_MAX + 0.15
          : randRange(FOREGROUND_LOW_MIN, FOREGROUND_LOW_MAX);
        const x = Math.sin(angle) * radius;
        const z = Math.cos(angle) * radius;
        const s = randRange(def.scaleRange[0], def.scaleRange[1]);
        dummy.position.set(x, 0, z);
        dummy.rotation.set(0, def.tangential ? angle : randRange(0, Math.PI * 2), 0);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;
      scene.add(inst);
    }

    // --- Wysoka zielen/zabudowa (promien 9.4-10.3): drzewa mini-forest + wieze,
    // budynki i palmy z pirate-kit. Zastepuje dawne proceduralne bryly
    // (BoxGeometry + vertexColors) prawdziwymi modelami Kenney - patrz CLAUDE.md,
    // pirate-kit jest ~1.5-2x wiekszy od siatki mini-*, wiec kazdy typ dostaje
    // wlasny wspolczynnik skali dobrany tak, zeby sylwetka pasowala do reszty
    // pierscienia (drzewa ~1.7-2.3 j., wieze/budynki ~2.2-3.1 j. - patrz komentarz
    // przy TALL_TYPES nizej z konkretnymi wysokosciami zmierzonymi z bbox GLB).
    const TALL_TYPES = [
      { key: 'tree', gltf: tree, count: 5, scaleRange: [0.85, 1.25] }, // h ~1.4-2.1
      { key: 'treeHigh', gltf: treeHigh, count: 3, scaleRange: [0.85, 1.2] }, // h ~1.9-2.7
      { key: 'tower', gltf: pTower, count: 4, scaleRange: [0.85, 1.05] }, // h (2.785 lokalnie) ~2.4-2.9
      { key: 'structure', gltf: pStructure, count: 4, scaleRange: [1.0, 1.3] }, // h (2.2 lokalnie) ~2.2-2.9
      { key: 'palmStraight', gltf: pPalmStraight, count: 3, scaleRange: [0.5, 0.65] }, // h (4.21 lokalnie) ~2.1-2.7
      { key: 'palmBend', gltf: pPalmBend, count: 2, scaleRange: [0.5, 0.62] }, // h (4.25 lokalnie) ~2.1-2.6
      { key: 'flag', gltf: pFlag, count: 1, scaleRange: [0.6, 0.7] }, // h (3.6 lokalnie) ~2.2-2.5
    ];
    const HUT_COUNT = 4; // "domki" mini-forest (struktura+dach) licza sie osobno - stackowana para

    for (const t of TALL_TYPES) {
      t.mesh = this._firstMesh(t.gltf);
      t.inst = new THREE.InstancedMesh(t.mesh.geometry, t.mesh.material, t.count);
      t.inst.castShadow = true; t.inst.receiveShadow = true; t.inst.frustumCulled = false;
      t.idx = 0;
    }
    const structMesh = this._firstMesh(bStruct);
    const roofMesh = this._firstMesh(bRoof);
    const structInst = new THREE.InstancedMesh(structMesh.geometry, structMesh.material, HUT_COUNT);
    const roofInst = new THREE.InstancedMesh(roofMesh.geometry, roofMesh.material, HUT_COUNT);
    structInst.castShadow = true; structInst.receiveShadow = true; structInst.frustumCulled = false;
    roofInst.castShadow = true; roofInst.receiveShadow = true; roofInst.frustumCulled = false;

    // Kolejka slotow: kazdy typ tyle razy, ile ma "count" (+ HUT_COUNT domkow),
    // przetasowana (Fisher-Yates) - kazdy z 26 slotow katowych dostaje losowy,
    // ale z gory ustalony w proporcjach typ. Dzieki temu zabudowa czyta sie jako
    // swiadomie skomponowany, zroznicowany pierscien (a nie czysty przypadek),
    // a jednoczesnie zaden typ nie grupuje sie przypadkiem w jednym miejscu.
    const slotQueue = [];
    for (const t of TALL_TYPES) for (let i = 0; i < t.count; i++) slotQueue.push(t.key);
    for (let i = 0; i < HUT_COUNT; i++) slotQueue.push('hut');
    for (let i = slotQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [slotQueue[i], slotQueue[j]] = [slotQueue[j], slotQueue[i]];
    }

    let hi = 0;
    for (let slot = 0; slot < slotQueue.length; slot++) {
      const angle = (slot / slotQueue.length) * Math.PI * 2 + randRange(-0.06, 0.06);
      const radius = randRange(FOREGROUND_TALL_MIN, FOREGROUND_TALL_MAX);
      const x = Math.sin(angle) * radius;
      const z = Math.cos(angle) * radius;
      const key = slotQueue[slot];

      if (key === 'hut') {
        const s = randRange(1.0, 1.6);
        const ry = randRange(0, Math.PI * 2);
        dummy.position.set(x, 0, z);
        dummy.rotation.set(0, ry, 0);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        structInst.setMatrixAt(hi, dummy.matrix);
        dummy.position.set(x, 1.0 * s, z);
        dummy.updateMatrix();
        roofInst.setMatrixAt(hi, dummy.matrix);
        hi++;
        continue;
      }
      const t = TALL_TYPES.find((tt) => tt.key === key);
      const s = randRange(t.scaleRange[0], t.scaleRange[1]);
      dummy.position.set(x, 0, z);
      dummy.rotation.set(0, randRange(0, Math.PI * 2), 0);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      t.inst.setMatrixAt(t.idx++, dummy.matrix);
    }

    for (const t of TALL_TYPES) t.inst.instanceMatrix.needsUpdate = true;
    structInst.instanceMatrix.needsUpdate = true;
    roofInst.instanceMatrix.needsUpdate = true;
    scene.add(...TALL_TYPES.map((t) => t.inst), structInst, roofInst);

    // --- Skomponowane zestawy przy niskim pierscieniu (promien 6.7-8.6):
    // stragan targowy (mini-market), oboz z mini-dungeon, pomnik z mini-areny,
    // rekwizyty portowe z pirate-kit - kazdy zestaw stoi w jednym miejscu jako
    // spojna scenka, nie rozrzucony losowo (patrz clusterXZ powyzej). Rozstawione
    // co 45 stopni, na przemian z "zielona" obreczą roslin/kamieni z lowDefs
    // powyzej - z kazdej strony areny jest wiec na co popatrzec. ---
    const CLUSTER_RADIUS = (FOREGROUND_LOW_MIN + FOREGROUND_LOW_MAX) / 2; // 7.65
    const deg = (d) => (d * Math.PI) / 180;

    const clusterPlacements = {}; // key -> [{x,y,z,ry,scale}]
    const addToCluster = (key, gltf, p) => {
      if (!clusterPlacements[key]) clusterPlacements[key] = { gltf, list: [] };
      clusterPlacements[key].list.push(p);
    };

    // Stragan targowy (glowny, 0 stopni) - piec rekwizytow mini-market obok siebie
    {
      const a = deg(0);
      const facing = a + Math.PI;
      addToCluster('mFreezer', mFreezer, { ...clusterXZ(a, CLUSTER_RADIUS, 0, -0.9), ry: facing, scale: 1 });
      addToCluster('mFruit', mFruit, { ...clusterXZ(a, CLUSTER_RADIUS, 0.1, -0.3), ry: facing, scale: 1 });
      addToCluster('mBasket', mBasket, { ...clusterXZ(a, CLUSTER_RADIUS, 0.35, 0.15), ry: facing + 0.4, scale: 1 });
      addToCluster('mCart', mCart, { ...clusterXZ(a, CLUSTER_RADIUS, 0.15, 0.6), ry: facing - 0.5, scale: 1 });
      addToCluster('mBottleReturn', mBottleReturn, { ...clusterXZ(a, CLUSTER_RADIUS, -0.1, 1.0), ry: facing, scale: 1 });
    }
    // Stragan targowy (drugi, 180 stopni) - mniejszy wariant
    {
      const a = deg(180);
      const facing = a + Math.PI;
      addToCluster('mCart', mCart, { ...clusterXZ(a, CLUSTER_RADIUS, 0, -0.35), ry: facing, scale: 1 });
      addToCluster('mBasket', mBasket, { ...clusterXZ(a, CLUSTER_RADIUS, 0.2, 0.25), ry: facing + 0.3, scale: 1 });
      addToCluster('mFruit', mFruit, { ...clusterXZ(a, CLUSTER_RADIUS, -0.2, 0.15), ry: facing, scale: 1 });
    }
    // Oboz z mini-dungeon (glowny, 60 stopni)
    {
      const a = deg(60);
      const facing = a + Math.PI;
      addToCluster('dWoodStruct', dWoodStruct, { ...clusterXZ(a, CLUSTER_RADIUS, 0, -0.6), ry: facing, scale: 1.1 });
      addToCluster('dWoodSupport', dWoodSupport, { ...clusterXZ(a, CLUSTER_RADIUS, 0.6, -0.6), ry: facing + 1.6, scale: 1.1 });
      addToCluster('dBarrel', dBarrel, { ...clusterXZ(a, CLUSTER_RADIUS, 0.3, 0.4), ry: facing, scale: 1.2 });
      addToCluster('dTable', dTable, { ...clusterXZ(a, CLUSTER_RADIUS, -0.3, 0.5), ry: facing + 0.7, scale: 1.15 });
    }
    // Oboz z mini-dungeon (drugi, 300 stopni)
    {
      const a = deg(300);
      const facing = a + Math.PI;
      addToCluster('dTable', dTable, { ...clusterXZ(a, CLUSTER_RADIUS, 0, 0), ry: facing, scale: 1.15 });
      addToCluster('dBarrel', dBarrel, { ...clusterXZ(a, CLUSTER_RADIUS, 0.35, 0.35), ry: facing, scale: 1.2 });
    }
    // Pomnik z mini-areny (120 stopni) - posag + sztandar obok
    {
      const a = deg(120);
      const facing = a + Math.PI;
      addToCluster('aStatue', aStatue, { ...clusterXZ(a, CLUSTER_RADIUS, 0, 0), ry: facing, scale: 1.0 });
      addToCluster('aBanner', aBanner, { ...clusterXZ(a, CLUSTER_RADIUS, -0.1, 0.75), ry: facing, scale: 1.0 });
    }
    // Rekwizyty portowe z pirate-kit (240 stopni) - beczki i skrzynie, w skali
    // obnizonej wzgledem oryginalu (pirate-kit jest ~2x wiekszy - patrz CLAUDE.md)
    {
      const a = deg(240);
      const facing = a + Math.PI;
      addToCluster('pBarrel', pBarrel, { ...clusterXZ(a, CLUSTER_RADIUS, 0, -0.35), ry: facing, scale: 0.5 });
      addToCluster('pBarrel', pBarrel, { ...clusterXZ(a, CLUSTER_RADIUS, 0.35, 0.25), ry: facing + 0.9, scale: 0.48 });
      addToCluster('pCrate', pCrate, { ...clusterXZ(a, CLUSTER_RADIUS, -0.3, 0.3), ry: facing, scale: 0.55 });
      addToCluster('pCrate', pCrate, { ...clusterXZ(a, CLUSTER_RADIUS, -0.15, 0.75), ry: facing + 0.4, scale: 0.52 });
    }

    const clusterMeshes = [];
    for (const { gltf, list } of Object.values(clusterPlacements)) {
      clusterMeshes.push(makeInstanced(gltf, list));
    }

    // --- Kilka kolumn z mini-arcade jako ozdobne pilastry przy co trzecim domku ---
    const columnGltf = await loadArcade('column');
    const columnMesh = this._firstMesh(columnGltf);
    const columnCount = 6;
    const columnInst = new THREE.InstancedMesh(columnMesh.geometry, columnMesh.material, columnCount * 2);
    columnInst.castShadow = true; columnInst.receiveShadow = true; columnInst.frustumCulled = false;
    let ci = 0;
    for (let i = 0; i < columnCount; i++) {
      const angle = (i / columnCount) * Math.PI * 2 + 0.3;
      const radius = FOREGROUND_TALL_MIN + 0.1;
      const x = Math.sin(angle) * radius;
      const z = Math.cos(angle) * radius;
      const perp = angle + Math.PI / 2;
      for (const sign of [-1, 1]) {
        const ox = x + Math.sin(perp) * 0.55 * sign;
        const oz = z + Math.cos(perp) * 0.55 * sign;
        dummy.position.set(ox, 0, oz);
        dummy.rotation.set(0, angle, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        columnInst.setMatrixAt(ci++, dummy.matrix);
      }
    }
    columnInst.instanceMatrix.needsUpdate = true;
    scene.add(columnInst);

    this.foregroundMeshes = [...TALL_TYPES.map((t) => t.inst), structInst, roofInst, ...clusterMeshes, columnInst];
  }

  // --- Plac pod arena - jedna bryla betonu, wierzch na y=0 (poziom podlogi areny) ---
  _buildPlaza(scene) {
    const geo = new THREE.BoxGeometry(PLAZA_HALF * 2, PLAZA_HEIGHT, PLAZA_HALF * 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x20242f, roughness: 0.95, metalness: 0.05 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, CITY_GROUND_Y + PLAZA_HEIGHT / 2, 0);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    scene.add(mesh);
    this.plazaMesh = mesh;

    // Cienki neonowy pasek Kicka na krawedzi placu, tuz PONIZEJ wierzchu placu.
    // Uwaga (naprawa Z-fightingu): pasek jest szerszy od placu tylko o 0.06, wiec
    // jego gorna sciana lezy nad CALA powierzchnia placu. Gdy obie byly na
    // dokladnie tej samej wysokosci (y = 0), caly plac wokol areny migotal przy
    // ruchu kamery - dwie nieprzezroczyste, wspolplaszczyznowe sciany walczyly
    // o glebie. Zepchniecie paska o EDGE_DROP w dol usuwa konflikt, a widoczna
    // z gory pozostaje dokladnie ta obwodka, o ktora chodzilo.
    const EDGE_DROP = 0.012;
    const edgeGeo = new THREE.BoxGeometry(PLAZA_HALF * 2 + 0.06, 0.06, PLAZA_HALF * 2 + 0.06);
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0x53fc18 });
    const edge = new THREE.Mesh(edgeGeo, edgeMat);
    edge.position.set(0, CITY_GROUND_Y + PLAZA_HEIGHT - 0.03 - EDGE_DROP, 0);
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
    mesh.receiveShadow = true;
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
      // Zbite z 0.7 - przy czystej bieli/zolci na czerni to byl maksymalny
      // mozliwy kontrast miedzy sasiednimi teksturami (jedna z przyczyn
      // szumu). Razem z przygaszonymi kolorami okien w createWindowTexture
      // daje to spokojna, przygaszona panorame zamiast stroboskopu.
      emissiveIntensity: 0.42,
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
    buildingMesh.castShadow = true;
    buildingMesh.receiveShadow = true;
    // InstancedMesh liczy domyslna kule odciecia (frustum culling) wokol
    // lokalnego originu geometrii bazowej, IGNORUJAC rozrzucenie instancji
    // przez ich wlasne macierze - przy budynkach rozrzuconych na promieniu
    // do CITY_HALF to obcina caly InstancedMesh naraz, gdy kamera nie patrzy
    // wprost na (0,0,0). Wylaczamy odciecie - liczba instancji jest mala,
    // koszt pominiecia CPU-side culling jest pomijalny.
    buildingMesh.frustumCulled = false;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const bodyPalette = [0x2a2e3a, 0x232735, 0x2e2440, 0x243044, 0x33251f];

    // Neonowe akcenty (szyldy) - male jasne prostopadloscianki na wybranych dachach, osobny InstancedMesh
    const neonCount = Math.max(1, Math.round(count * 0.08));
    const neonMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
    const neonMesh = new THREE.InstancedMesh(boxGeo, neonMat, neonCount);
    neonMesh.frustumCulled = false;
    const neonPalette = [0x53fc18, 0xff4fd8, 0x4fd8ff, 0xffd166, 0xff5c5c];
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
