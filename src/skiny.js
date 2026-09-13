// Tabela skinow wybieranych z czatu (komenda "!skin <nazwa>", patrz kick.js i
// workers.js). Kazdy skin to model z jednej z paczek Kenney juz obecnych w
// assets/ (arcade/dungeon/arena/forest) albo z nowej assets/blocky/ -
// wszystkie sprawdzone (patrz raport), ze maja klipy idle/walk/interact-right/die,
// ktorych szuka WorkerManager.
//
// "loader" to funkcja z assets.js dla wlasciwego katalogu/colormapu paczki
// (patrz CLAUDE.md - kazda paczka ma WLASNY colormap.png, mieszanie katalogow
// psuje tekstury). "scale" to wspolczynnik dopasowania wysokosci do reszty
// rigu (mini-pack postacie sa scale=1, tylko blocky-characters jest ~4x za
// duze - patrz BLOCKY_SCALE nizej).

import { loadArcade, loadDungeon, loadArena, loadForest, loadBlocky } from './assets.js';

// kenney_blocky-characters character-a ma pelna wysokosc (root->torso->head,
// policzona z transformacji wezlow w GLB, patrz raport skryptu bbox2.js) ok.
// 2.70 jednostki, wobec ok. 0.6713 dla character-male-a (ten sam pomiar
// bbox z accessora POSITION) - 0.6713 / 2.70 = 0.2486.
const BLOCKY_SCALE = 0.2486;

export const SKINS = {
  // assets/arcade (kenney_mini-arcade, colormap wspolny z mini-market/mini-characters)
  'kasjer': { loader: loadArcade, model: 'character-employee', scale: 1 },
  'mezczyzna-a': { loader: loadArcade, model: 'character-male-a', scale: 1 },
  'mezczyzna-b': { loader: loadArcade, model: 'character-male-b', scale: 1 },
  'mezczyzna-c': { loader: loadArcade, model: 'character-male-c', scale: 1 },
  'mezczyzna-d': { loader: loadArcade, model: 'character-male-d', scale: 1 },
  'mezczyzna-e': { loader: loadArcade, model: 'character-male-e', scale: 1 },
  'mezczyzna-f': { loader: loadArcade, model: 'character-male-f', scale: 1 },
  'kobieta-a': { loader: loadArcade, model: 'character-female-a', scale: 1 },
  'kobieta-b': { loader: loadArcade, model: 'character-female-b', scale: 1 },
  'kobieta-c': { loader: loadArcade, model: 'character-female-c', scale: 1 },
  'kobieta-d': { loader: loadArcade, model: 'character-female-d', scale: 1 },
  'kobieta-e': { loader: loadArcade, model: 'character-female-e', scale: 1 },
  'kobieta-f': { loader: loadArcade, model: 'character-female-f', scale: 1 },

  // assets/dungeon (kenney_mini-dungeon, wlasny colormap)
  'orc': { loader: loadDungeon, model: 'character-orc', scale: 1 },
  'czlowiek': { loader: loadDungeon, model: 'character-human', scale: 1 },

  // assets/arena (kenney_mini-arena, wlasny colormap)
  'zolnierz': { loader: loadArena, model: 'character-soldier', scale: 1 },

  // assets/forest (kenney_mini-forest, wlasny colormap)
  'lucznik': { loader: loadForest, model: 'character-archer', scale: 1 },

  // assets/blocky (kenney_blocky-characters, 18 postaci, kazda z WLASNA
  // tekstura texture-a..r.png - brak wspolnego atlasu, patrz CLAUDE.md)
  'blok-a': { loader: loadBlocky, model: 'character-a', scale: BLOCKY_SCALE },
  'blok-b': { loader: loadBlocky, model: 'character-b', scale: BLOCKY_SCALE },
  'blok-c': { loader: loadBlocky, model: 'character-c', scale: BLOCKY_SCALE },
  'blok-d': { loader: loadBlocky, model: 'character-d', scale: BLOCKY_SCALE },
  'blok-e': { loader: loadBlocky, model: 'character-e', scale: BLOCKY_SCALE },
  'blok-f': { loader: loadBlocky, model: 'character-f', scale: BLOCKY_SCALE },
  'blok-g': { loader: loadBlocky, model: 'character-g', scale: BLOCKY_SCALE },
  'blok-h': { loader: loadBlocky, model: 'character-h', scale: BLOCKY_SCALE },
  'blok-i': { loader: loadBlocky, model: 'character-i', scale: BLOCKY_SCALE },
  'blok-j': { loader: loadBlocky, model: 'character-j', scale: BLOCKY_SCALE },
  'blok-k': { loader: loadBlocky, model: 'character-k', scale: BLOCKY_SCALE },
  'blok-l': { loader: loadBlocky, model: 'character-l', scale: BLOCKY_SCALE },
  'blok-m': { loader: loadBlocky, model: 'character-m', scale: BLOCKY_SCALE },
  'blok-n': { loader: loadBlocky, model: 'character-n', scale: BLOCKY_SCALE },
  'blok-o': { loader: loadBlocky, model: 'character-o', scale: BLOCKY_SCALE },
  'blok-p': { loader: loadBlocky, model: 'character-p', scale: BLOCKY_SCALE },
  'blok-q': { loader: loadBlocky, model: 'character-q', scale: BLOCKY_SCALE },
  'blok-r': { loader: loadBlocky, model: 'character-r', scale: BLOCKY_SCALE },
};

/** Czy `nazwa` (juz znormalizowana - male litery) jest skinem z tabeli. */
export function isValidSkin(nazwa) {
  return Object.prototype.hasOwnProperty.call(SKINS, nazwa);
}

/** Lista nazw skinow w kolejnosci deklaracji - do wyswietlenia w panelu legendy. */
export function getSkinNames() {
  return Object.keys(SKINS);
}

/**
 * Laduje (i cache'uje przez wlasciwy loader z assets.js) model danego skina.
 * Zwraca null dla nieznanej nazwy - wolajacy ma sam zdecydowac, co z tym
 * zrobic (np. cicho zignorowac komende czatu).
 */
export function loadSkin(nazwa) {
  const def = SKINS[nazwa];
  if (!def) return null;
  return def.loader(def.model);
}

/** Zwraca definicje skina (loader/model/scale) albo null. */
export function getSkinDef(nazwa) {
  return SKINS[nazwa] || null;
}
