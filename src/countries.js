// src/countries.js
// Zbiór najpopularniejszych krajów używanych w minigrze "Bitwa o flagi".
// Kody ISO muszą odpowiadać plikom w folderze assets/flags (np. PL.png).
// Zastosowaliśmy mniejszy zbiór dla grywalności (aby gracze mogli zgadnąć).

export const COUNTRIES = {
  PL: 'Polska',
  DE: 'Niemcy',
  FR: 'Francja',
  IT: 'Wlochy',
  ES: 'Hiszpania',
  GB: 'Wielka Brytania',
  US: 'USA',
  CA: 'Kanada',
  BR: 'Brazylia',
  AR: 'Argentyna',
  MX: 'Meksyk',
  AU: 'Australia',
  JP: 'Japonia',
  CN: 'Chiny',
  IN: 'Indie',
  RU: 'Rosja',
  KR: 'Korea Poludniowa',
  PT: 'Portugalia',
  NL: 'Holandia',
  BE: 'Belgia',
  SE: 'Szwecja',
  NO: 'Norwegia',
  FI: 'Finlandia',
  DK: 'Dania',
  CH: 'Szwajcaria',
  AT: 'Austria',
  CZ: 'Czechy',
  SK: 'Slowacja',
  HU: 'Wegry',
  UA: 'Ukraina',
  RO: 'Rumunia',
  BG: 'Bulgaria',
  GR: 'Grecja',
  TR: 'Turcja',
  EG: 'Egipt',
  ZA: 'RPA',
  NG: 'Nigeria',
  KE: 'Kenia',
  CO: 'Kolumbia',
  CL: 'Chile',
  PE: 'Peru',
  VE: 'Wenezuela',
  CU: 'Kuba',
  SA: 'Arabia Saudyjska',
  AE: 'ZEA',
  IL: 'Izrael',
  ID: 'Indonezja',
  MY: 'Malezja',
  TH: 'Tajlandia',
  VN: 'Wietnam',
  PH: 'Filipiny',
  NZ: 'Nowa Zelandia',
  IE: 'Irlandia',
  IS: 'Islandia',
  HR: 'Chorwacja',
  RS: 'Serbia',
  LT: 'Litwa',
  LV: 'Lotwa',
  EE: 'Estonia',
  DZ: 'Algieria',
  MA: 'Maroko',
  JM: 'Jamajka'
};

export const COUNTRY_CODES = Object.keys(COUNTRIES);

// Funkcja normalizująca nazwy (usuwająca polskie znaki diakrytyczne i duże litery)
export function normalizeCountryName(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}
