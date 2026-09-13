import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Bez tego kazdy z ~20 modeli GLB ciagnie wlasna kopie Textures/colormap.png
// (GLTFLoader nie deduplikuje zadan miedzy osobnymi load()). THREE.Cache sprawia,
// ze tekstura leci po sieci raz.
THREE.Cache.enabled = true;

const loader = new GLTFLoader();

// Maksymalna anizotropia karty - ustawiana raz z main.js (patrz setTextureQuality),
// bo fixMaterials nie ma dostepu do renderera.
let maxAnisotropy = 1;

/** Podaje rendererowi zaleznej jakosci filtrowania tekstur. Wolac przed preloadAll(). */
export function setTextureQuality(renderer) {
  if (renderer && renderer.capabilities && typeof renderer.capabilities.getMaxAnisotropy === 'function') {
    maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  }
  return maxAnisotropy;
}
const cache = new Map(); // path -> Promise<GLTF>

export const MACHINE_KEYS = [
  'gambling-machine', 'vending-machine', 'ticket-machine',
  'arcade-machine', 'claw-machine', 'dance-machine',
];

const ARCADE_PATH = 'assets/arcade/';
const DUNGEON_PATH = 'assets/dungeon/';
const FOREST_PATH = 'assets/forest/';
const PIRATE_PATH = 'assets/pirate/';
const ARENA_PATH = 'assets/arena/';
const BLASTER_PATH = 'assets/blaster/';
// kenney_cube-pets ma WLASNY Textures/colormap.png - osobny katalog assets/cubepets/.
// Uzywane wylacznie do dekoracyjnego "placu zabaw" na przedpolu (patrz city.js).
const CUBEPETS_PATH = 'assets/cubepets/';
// kenney_blocky-characters ma WLASNY zestaw 18 tekstur (texture-a..r.png, patrz
// CLAUDE.md) - osobny katalog assets/blocky/. Uzywane wylacznie jako skiny
// (patrz src/skiny.js) - postacie sa ~4x wieksze niz reszta rigu, dlatego
// skiny.js dobiera im wspolczynnik skali dopasowany do character-male-a.
const BLOCKY_PATH = 'assets/blocky/';

function fixMaterials(root) {
  root.traverse((node) => {
    if (node.isMesh && node.material) {
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of mats) {
        if (mat.map) {
          mat.map.colorSpace = THREE.SRGBColorSpace;
          mat.map.magFilter = THREE.NearestFilter;
          // Filtrowanie anizotropowe. Atlas palety (colormap.png) jest probkowany
          // plaskimi swatchami, wiec przy plaskim kacie patrzenia na posadzke
          // mipmapy potrafia mieszac sasiadujace barwy z atlasu - to widac jako
          // migotanie/przelewanie sie koloru przy ruchu kamery, najsilniej na
          // ciemnych polach (najwiekszy kontrast wzgledem sasiada w atlasie).
          // Anizotropia mocno ogranicza ten efekt na powierzchniach ogladanych
          // pod ostrym katem. Wartosc ustawia main.js przez setTextureQuality().
          if (maxAnisotropy > 1) mat.map.anisotropy = maxAnisotropy;
          mat.map.needsUpdate = true;
        }
      }
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });
}

// Przy ERR_CONNECTION_RESET (zerwanie polaczenia na poziomie TCP, w odroznieniu
// od zwyklego bledu HTTP typu 404) potrafi sie zdarzyc, ze wewnetrzny fetch()
// uzywany przez GLTFLoader/FileLoader nigdy nie rozstrzyga zwroconego Promise
// (ani resolve, ani reject) - loadAsync() wisi w nieskonczonosc. Bez limitu
// czasu taki jeden zawieszony model blokowalby na zawsze petle w
// syncLeaderboardAndOverlays (patrz main.js). Kazda proba dostaje wlasny timeout.
const LOAD_ATTEMPT_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout (${ms}ms) przy ladowaniu: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Proste serwery statyczne (python -m http.server) potrafia zerwac polaczenie
 * przy kilkunastu rownoleglych zadaniach - stad proby ponowne + limit czasu
 * na kazda z nich (patrz komentarz przy LOAD_ATTEMPT_TIMEOUT_MS).
 */
async function loadWithRetry(path, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(loader.loadAsync(path), LOAD_ATTEMPT_TIMEOUT_MS, path);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw new Error(`Nie udalo sie zaladowac ${path}: ${lastErr}`);
}

// Wspolny limiter wspolbieznosci - uzywany zarowno przez preloadAll(), jak i
// przez dociaganie modeli postaci "na zadanie" (np. gdy 10 widzow wchodzi do
// Top 10 naraz). Bez tego leci seria rownoleglych zadan i prosty serwer
// deweloperski zaczyna zrywac polaczenia (ERR_CONNECTION_RESET).
const MAX_CONCURRENT_LOADS = 4;
let activeLoads = 0;
const loadQueue = [];

function runQueued() {
  while (activeLoads < MAX_CONCURRENT_LOADS && loadQueue.length > 0) {
    const { task, resolve, reject } = loadQueue.shift();
    activeLoads += 1;
    task()
      .then(resolve, reject)
      .finally(() => {
        activeLoads -= 1;
        runQueued();
      });
  }
}

function enqueue(task) {
  return new Promise((resolve, reject) => {
    loadQueue.push({ task, resolve, reject });
    runQueued();
  });
}

function loadGltf(path) {
  if (cache.has(path)) return cache.get(path);
  const p = enqueue(() => loadWithRetry(path)).then((gltf) => {
    fixMaterials(gltf.scene);
    return gltf;
  });
  // Jesli ladowanie sie nie powiedzie, usuwamy wpis z cache - inaczej jeden
  // chwilowy blad sieci "zatruwa" cache na reszte sesji i kolejne proby
  // natychmiast odrzucaja z tym samym starym bledem, mimo ze serwer juz dziala.
  p.catch(() => {
    if (cache.get(path) === p) {
      cache.delete(path);
    }
  });
  cache.set(path, p);
  return p;
}

/** Uruchamia zadania partiami, zeby nie zasypac serwera naraz. */
async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

export function loadArcade(name) {
  return loadGltf(`${ARCADE_PATH}${name}.glb`);
}

export function loadDungeon(name) {
  return loadGltf(`${DUNGEON_PATH}${name}.glb`);
}

// mini-forest ma WLASNY Textures/colormap.png (rozna tresc niz arcade/dungeon) -
// stad osobny katalog assets/forest/ i osobna funkcja ladujaca (patrz CLAUDE.md,
// sekcja "Texture filenames collide across packs").
export function loadForest(name) {
  return loadGltf(`${FOREST_PATH}${name}.glb`);
}

// kenney_pirate-kit ma WLASNY Textures/colormap.png (inna tresc niz arcade/dungeon/forest) -
// stad osobny katalog assets/pirate/ i osobna funkcja ladujaca (patrz CLAUDE.md).
export function loadPirate(name) {
  return loadGltf(`${PIRATE_PATH}${name}.glb`);
}

// kenney_mini-arena ma rowniez WLASNY Textures/colormap.png - osobny katalog assets/arena/.
export function loadArena(name) {
  return loadGltf(`${ARENA_PATH}${name}.glb`);
}

// kenney_blaster-kit ma WLASNY Textures/colormap.png - osobny katalog assets/blaster/.
// Stad pochodzi wyrzutnik bossa i glowice rakiet (patrz boss.js).
export function loadBlaster(name) {
  return loadGltf(`${BLASTER_PATH}${name}.glb`);
}

export function loadCubePets(name) {
  return loadGltf(`${CUBEPETS_PATH}${name}.glb`);
}

export function loadBlocky(name) {
  return loadGltf(`${BLOCKY_PATH}${name}.glb`);
}

/**
 * Laduje to, co jest potrzebne do pierwszej klatki: pokoj, maszyny i monete.
 * Postacie celowo NIE sa tu preladowane - jest ich 13, a na starcie zwykle nie
 * ma ani jednego pracownika. WorkerManager dociaga model przy pierwszym
 * zatrudnieniu i cache'uje go dalej sam.
 */
export async function preloadAll() {
  // Pierwszy model leci sam - pociagnie za soba colormap.png do THREE.Cache,
  // dzieki czemu reszta partii juz nie walczy o te sama teksture.
  await loadArcade('floor');
  const names = ['wall', 'wall-corner', 'column', ...MACHINE_KEYS];
  await inBatches(names, 4, (n) => loadArcade(n));
  await loadDungeon('coin');
}

