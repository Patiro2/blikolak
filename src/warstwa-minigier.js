// Warstwa wymuszajaca, zeby karty minigier (sprite'y 3D bitwy o flagi,
// tlumaczen, panstw-miast i "Zgadnij marke") byly zawsze NAD reszta sceny
// (postacie, jetpack, dekoracje) i NAD nickami/dymkami pracownikow (HTML w
// #worker-overlays, z-index 15 nad canvasem - samo z-index nie wystarczy,
// bo canvas jest nieprzezroczysty i rysuje sie w swojej wlasnej kolejnosci
// glebi). Dwie oddzielne rzeczy, obie idempotentne (mozna wolac co klatke
// bez skutkow ubocznych):
//  1) na sprite'ach kart ustawiamy depthTest/depthWrite = false i wysoki
//     renderOrder, zeby three.js rysowal je na samym koncu, nad modelami.
//  2) HTML-owe plakietki/dymki, ktore na EKRANIE naklada by sie na kartke,
//     dostaja przygaszone opacity, zeby nie zaslanialy tekstu/flagi/logo.
//
// Managery (flagBattle/tlumaczenia/panstwaMiasta/bitwaMarek) NIE sa tu
// modyfikowane poza materialem/renderOrder ich wlasnych sprite'ow - zadna
// tekstura ani pozycja nie jest ruszana (patrz zadanie).

import * as THREE from 'three';

const RENDER_ORDER = 1000;
const MARGIN_PX = 12; // margines wokol prostokata karty na ekranie
const PRZYGASZONE_OPACITY = '0.12';
const CO_ILE_KLATEK = 3; // kosmetyka - nie potrzebuje przeliczen co 60fps

/** Dopisuje do `out` sprite'y z pol `pola` managera oraz (opcjonalnie) sprite'y z dynamicznej tablicy `tablicaPola`. */
function zbierzSprites(manager, pola, tablicaPola, out) {
  if (!manager) return;
  for (const pole of pola) {
    const sprite = manager[pole];
    if (sprite) out.push(sprite);
  }
  if (tablicaPola) {
    const tab = manager[tablicaPola];
    if (Array.isArray(tab)) {
      for (const wpis of tab) {
        if (wpis && wpis.sprite) out.push(wpis.sprite);
      }
    }
  }
}

/** Idempotentnie ustawia depthTest/depthWrite/renderOrder tak, zeby sprite rysowal sie nad wszystkim. */
function wymusPierwszaWarstwe(sprite) {
  const mat = sprite.material;
  if (mat && mat.depthTest !== false) mat.depthTest = false;
  if (mat && mat.depthWrite !== false) mat.depthWrite = false;
  if (sprite.renderOrder !== RENDER_ORDER) sprite.renderOrder = RENDER_ORDER;
}

/** Czy sprite (i cala linia jego rodzicow) jest widoczny. */
function czySpriteWidoczny(sprite) {
  let node = sprite;
  while (node) {
    if (node.visible === false) return false;
    node = node.parent;
  }
  return true;
}

const _tmpV = new THREE.Vector3();

/** Prostokat ekranowy (piksele, wzgledem okna) sprite'a albo null, gdy niewidoczny/za kamera. */
function prostokatEkranowy(sprite, camera, canvasRect) {
  if (!czySpriteWidoczny(sprite)) return null;
  // Sprite'y kart sa dodawane wprost do sceny (bez transformujacego rodzica -
  // patrz flagbattle.js/tlumaczenia.js/panstwa-miasta.js/bitwa-marek.js),
  // wiec sprite.position juz jest pozycja swiatowa.
  _tmpV.copy(sprite.position);
  const camSpace = _tmpV.clone().applyMatrix4(camera.matrixWorldInverse);
  if (camSpace.z >= 0) return null; // karta za kamera
  const distance = -camSpace.z;
  const proj = _tmpV.clone().project(camera);
  const sx = (proj.x * 0.5 + 0.5) * canvasRect.width + canvasRect.left;
  const sy = (-proj.y * 0.5 + 0.5) * canvasRect.height + canvasRect.top;
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const pxPerUnit = canvasRect.height / (2 * distance * Math.tan(vFov / 2));
  const halfW = (sprite.scale.x / 2) * pxPerUnit + MARGIN_PX;
  const halfH = (sprite.scale.y / 2) * pxPerUnit + MARGIN_PX;
  return { left: sx - halfW, right: sx + halfW, top: sy - halfH, bottom: sy + halfH };
}

function prostokatyNachodzaSie(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export class WarstwaMinigier {
  /**
   * @param {THREE.Camera} camera
   * @param {HTMLElement} overlaysContainer - #worker-overlays
   * @param {{flagBattle, tlumaczenia, panstwaMiasta, bitwaMarek}} managers
   */
  constructor(camera, overlaysContainer, managers) {
    this.camera = camera;
    this.container = overlaysContainer || document.getElementById('worker-overlays');
    this.managers = managers;
    this._klatka = 0;
    // Bufory wielokrotnego uzytku - zero alokacji tablic w petli animacji.
    this._spritesBuf = [];
    this._rectBuf = [];
    this._przygaszone = new Set(); // elementy DOM, ktore MY przygasilismy - zeby wiedziec co zgasic z powrotem
  }

  /** Wolane co klatke z animate() w main.js - throttling wewnatrz (patrz CO_ILE_KLATEK). */
  update(canvasRect) {
    this._klatka++;
    if (this._klatka % CO_ILE_KLATEK !== 0) return;
    if (!this.camera || !canvasRect || !canvasRect.width || !canvasRect.height) return;

    const { flagBattle, tlumaczenia, panstwaMiasta, bitwaMarek } = this.managers;
    const sprites = this._spritesBuf;
    sprites.length = 0;
    zbierzSprites(flagBattle, ['flagSprite', 'revealSprite'], null, sprites);
    zbierzSprites(tlumaczenia, ['wordSprite'], null, sprites);
    zbierzSprites(panstwaMiasta, ['letterSprite'], 'rubrykaSprites', sprites);
    zbierzSprites(bitwaMarek, ['brandSprite', 'revealSprite'], null, sprites);

    // Krok 3 z zadania: karty NAD modelami - idempotentne, wiec mozna
    // odpalac przy kazdym sprawdzeniu (obejmuje tez swiezo utworzone
    // rubrykaSprites panstw-miast).
    for (const sprite of sprites) wymusPierwszaWarstwe(sprite);

    const prostokaty = this._rectBuf;
    prostokaty.length = 0;
    for (const sprite of sprites) {
      const r = prostokatEkranowy(sprite, this.camera, canvasRect);
      if (r) prostokaty.push(r);
    }

    const elementy = this.container
      ? this.container.querySelectorAll('.worker-nameplate, .worker-bubble')
      : [];

    // Najpierw SAME ODCZYTY layoutu (getBoundingClientRect) dla wszystkich
    // elementow, dopiero potem zapisy - unika layout thrashingu.
    const wpisy = [];
    for (const el of elementy) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue; // display:none (nieaktywny dymek/plakietka)
      wpisy.push({ el, rect });
    }

    const nowePrzygaszone = new Set();
    if (prostokaty.length > 0) {
      for (const { el, rect } of wpisy) {
        const nachodzi = prostokaty.some((k) => prostokatyNachodzaSie(rect, k));
        if (nachodzi) {
          if (!el.style.transition) el.style.transition = 'opacity 0.15s ease';
          el.style.opacity = PRZYGASZONE_OPACITY;
          nowePrzygaszone.add(el);
        }
      }
    }
    // Elementy przygaszone poprzednio, ktore juz nie nachodza (albo zaden
    // prostokat karty juz nie istnieje) - wracaja do pustego opacity, czyli
    // do tego, co i tak dyktuje CSS (patrz .worker-nameplate/.worker-bubble
    // w style.css) - nie ruszamy zadnego INNEGO inline stylu (np. display).
    for (const el of this._przygaszone) {
      if (!nowePrzygaszone.has(el)) el.style.opacity = '';
    }
    this._przygaszone = nowePrzygaszone;
  }
}
