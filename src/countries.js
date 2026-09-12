// src/countries.js
// Zbiór krajów używanych w minigrze "Bitwa o flagi".
// Kody ISO muszą odpowiadać plikom w folderze assets/flags-vector (np. PL.svg),
// z wyjątkiem kilku kodów obsłużonych awaryjnie przez assets/flags-png/
// (patrz komentarz przy KODY_PNG_FALLBACK w flagbattle.js).
// Zastosowaliśmy zbiór dobrany pod grywalność (kraje, które polski czat ma
// szansę rozpoznać po fladze i nazwać) - bez terytoriów zależnych ani
// mikroskopijnych wysp, których nikt nie zgadnie.

export const COUNTRIES = {
  PL: 'Polska',
  DE: 'Niemcy',
  FR: 'Francja',
  IT: 'Włochy',
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
  KR: 'Korea Południowa',
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
  SK: 'Słowacja',
  HU: 'Węgry',
  UA: 'Ukraina',
  RO: 'Rumunia',
  BG: 'Bułgaria',
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
  LV: 'Łotwa',
  EE: 'Estonia',
  DZ: 'Algieria',
  MA: 'Maroko',
  JM: 'Jamajka',

  // --- Rozszerzenie: Europa ---
  AL: 'Albania',
  BA: 'Bośnia i Hercegowina',
  MK: 'Macedonia Północna',
  ME: 'Czarnogóra',
  SI: 'Słowenia',
  MT: 'Malta',
  CY: 'Cypr',
  LU: 'Luksemburg',
  MD: 'Mołdawia',
  BY: 'Białoruś',
  LI: 'Liechtenstein',
  MC: 'Monako',
  AD: 'Andora',
  SM: 'San Marino',
  VA: 'Watykan',

  // --- Rozszerzenie: Azja ---
  PK: 'Pakistan',
  BD: 'Bangladesz',
  AF: 'Afganistan',
  IQ: 'Irak',
  IR: 'Iran',
  JO: 'Jordania',
  LB: 'Liban',
  SY: 'Syria',
  YE: 'Jemen',
  OM: 'Oman',
  QA: 'Katar',
  KW: 'Kuwejt',
  BH: 'Bahrajn',
  UZ: 'Uzbekistan',
  KZ: 'Kazachstan',
  KG: 'Kirgistan',
  TJ: 'Tadżykistan',
  TM: 'Turkmenistan',
  MN: 'Mongolia',
  NP: 'Nepal',
  LK: 'Sri Lanka',
  MM: 'Mjanma',
  KH: 'Kambodża',
  LA: 'Laos',
  SG: 'Singapur',
  TW: 'Tajwan',
  HK: 'Hongkong',
  MO: 'Makau',
  KP: 'Korea Północna',
  GE: 'Gruzja',
  AM: 'Armenia',
  AZ: 'Azerbejdżan',
  BT: 'Bhutan',
  MV: 'Malediwy',
  BN: 'Brunei',
  PS: 'Palestyna',

  // --- Rozszerzenie: Afryka ---
  TN: 'Tunezja',
  LY: 'Libia',
  SD: 'Sudan',
  SS: 'Sudan Południowy',
  ET: 'Etiopia',
  SO: 'Somalia',
  UG: 'Uganda',
  TZ: 'Tanzania',
  RW: 'Rwanda',
  GH: 'Ghana',
  CI: 'Wybrzeże Kości Słoniowej',
  SN: 'Senegal',
  ML: 'Mali',
  NE: 'Niger',
  CM: 'Kamerun',
  CD: 'Demokratyczna Republika Konga',
  CG: 'Kongo',
  GA: 'Gabon',
  AO: 'Angola',
  MZ: 'Mozambik',
  ZM: 'Zambia',
  ZW: 'Zimbabwe',
  NA: 'Namibia',
  BW: 'Botswana',
  MG: 'Madagaskar',
  MU: 'Mauritius',
  SC: 'Seszele',

  // --- Rozszerzenie: obie Ameryki ---
  EC: 'Ekwador',
  BO: 'Boliwia',
  PY: 'Paragwaj',
  UY: 'Urugwaj',
  PA: 'Panama',
  CR: 'Kostaryka',
  NI: 'Nikaragua',
  HN: 'Honduras',
  GT: 'Gwatemala',
  SV: 'Salwador',
  DO: 'Dominikana',
  HT: 'Haiti',
  BS: 'Bahamy',
  DM: 'Dominika',

  // --- Rozszerzenie: Oceania ---
  FJ: 'Fidżi',
  PG: 'Papua-Nowa Gwinea',
};

export const COUNTRY_CODES = Object.keys(COUNTRIES);

/**
 * Dodatkowe akceptowane warianty odpowiedzi na czacie, poza pełną nazwą z
 * COUNTRIES (ta zawsze jest akceptowana automatycznie - patrz getWarianty
 * niżej). Skróty, nazwy potoczne i angielskie odpowiedniki dla popularnych
 * krajów. Wpisy są tu zapisane zwykłym tekstem (z polskimi znakami albo bez -
 * i tak przechodzą przez normalizeCountryName przy porównaniu).
 *
 * UWAGA o niejednoznaczności: celowo NIE dodajemy wariantów, które pasowałyby
 * do więcej niż jednego kraju obecnego w grze (np. samo "korea" - w grze są
 * KR i KP; samo "kongo" - w grze są CD i CG). Zamiast tego warianty dla takich
 * krajów są doprecyzowane (np. "korea pld" tylko dla KR).
 */
export const COUNTRY_VARIANTS = {
  PL: ['poland'],
  DE: ['germany'],
  FR: ['france'],
  IT: ['italy'],
  ES: ['spain'],
  GB: ['anglia', 'wielka brytania', 'zjednoczone krolestwo', 'uk', 'united kingdom', 'england'],
  US: ['usa', 'stany zjednoczone', 'united states', 'stany'],
  CA: ['canada'],
  BR: ['brazil'],
  AR: ['argentina'],
  MX: ['mexico'],
  AU: ['australia'],
  JP: ['japan'],
  CN: ['china'],
  IN: ['india'],
  RU: ['russia'],
  KR: ['korea pld', 'korea pd', 'korea poludniowa', 'south korea'],
  PT: ['portugal'],
  NL: ['holandia', 'niderlandy', 'netherlands'],
  BE: ['belgium'],
  SE: ['sweden'],
  NO: ['norway'],
  FI: ['finland'],
  DK: ['denmark'],
  CH: ['switzerland'],
  AT: ['austria'],
  CZ: ['czech republic', 'czechia'],
  SK: ['slovakia'],
  HU: ['hungary'],
  UA: ['ukraine'],
  RO: ['romania'],
  BG: ['bulgaria'],
  GR: ['greece'],
  TR: ['turkey'],
  EG: ['egypt'],
  ZA: ['rpa', 'republika poludniowej afryki', 'south africa'],
  NG: ['nigeria'],
  KE: ['kenya'],
  CO: ['colombia'],
  CL: ['chile'],
  PE: ['peru'],
  VE: ['venezuela'],
  CU: ['cuba'],
  SA: ['saudi arabia', 'arabia saudyjska'],
  AE: ['zea', 'zjednoczone emiraty arabskie', 'emiraty'],
  IL: ['israel'],
  ID: ['indonesia'],
  MY: ['malaysia'],
  TH: ['thailand'],
  VN: ['vietnam'],
  PH: ['philippines'],
  NZ: ['new zealand'],
  IE: ['ireland'],
  IS: ['iceland'],
  HR: ['croatia'],
  RS: ['serbia'],
  LT: ['lithuania'],
  LV: ['latvia'],
  EE: ['estonia'],
  DZ: ['algeria'],
  MA: ['morocco'],
  JM: ['jamaica'],

  AL: ['albania'],
  BA: ['bosnia i hercegowina', 'bosnia'],
  MK: ['macedonia polnocna', 'macedonia'],
  ME: ['czarnogora', 'montenegro'],
  SI: ['slowenia', 'slovenia'],
  MT: ['malta'],
  CY: ['cyprus'],
  LU: ['luxembourg'],
  MD: ['moldova'],
  BY: ['bialorus', 'belarus'],
  LI: ['liechtenstein'],
  MC: ['monaco'],
  VA: ['watykan', 'vatican'],

  PK: ['pakistan'],
  BD: ['bangladesh'],
  AF: ['afghanistan'],
  IQ: ['iraq'],
  IR: ['iran'],
  JO: ['jordan'],
  LB: ['lebanon'],
  SY: ['syria'],
  YE: ['yemen'],
  QA: ['qatar'],
  KW: ['kuwait'],
  UZ: ['uzbekistan'],
  KZ: ['kazachstan', 'kazakhstan'],
  MN: ['mongolia'],
  NP: ['nepal'],
  LK: ['sri lanka'],
  MM: ['mjanma', 'birma', 'myanmar'],
  KH: ['cambodia'],
  SG: ['singapore'],
  TW: ['taiwan'],
  HK: ['hong kong'],
  MO: ['macau'],
  KP: ['korea pn', 'korea polnocna', 'north korea'],
  GE: ['georgia'],
  AZ: ['azerbaijan'],
  MV: ['maldives'],
  BN: ['brunei'],
  PS: ['palestine', 'palestyna'],

  TN: ['tunisia'],
  LY: ['libya'],
  SS: ['sudan poludniowy', 'south sudan'],
  ET: ['ethiopia'],
  SO: ['somalia'],
  UG: ['uganda'],
  TZ: ['tanzania'],
  RW: ['rwanda'],
  GH: ['ghana'],
  CI: ['wybrzeze kosci sloniowej', 'ivory coast', 'cote divoire'],
  SN: ['senegal'],
  ML: ['mali'],
  NE: ['niger'],
  CM: ['cameroon'],
  CD: ['demokratyczna republika konga', 'kongo kinszasa', 'dr konga', 'dr congo'],
  CG: ['kongo brazzaville', 'republic of the congo'],
  GA: ['gabon'],
  AO: ['angola'],
  MZ: ['mozambique'],
  ZM: ['zambia'],
  ZW: ['zimbabwe'],
  NA: ['namibia'],
  BW: ['botswana'],
  MG: ['madagascar'],
  MU: ['mauritius'],
  SC: ['seychelles'],

  EC: ['ecuador'],
  BO: ['bolivia'],
  PY: ['paraguay'],
  UY: ['uruguay'],
  PA: ['panama'],
  CR: ['costa rica'],
  NI: ['nicaragua'],
  HN: ['honduras'],
  GT: ['guatemala'],
  SV: ['salvador', 'el salvador'],
  DO: ['dominikana', 'dominican republic'],
  HT: ['haiti'],
  BS: ['bahamas'],
  DM: ['dominica'],

  FJ: ['fiji'],
  PG: ['papua nowa gwinea', 'papua new guinea'],
};

/**
 * Zwraca liste ZNORMALIZOWANYCH (normalizeCountryName) wariantow odpowiedzi
 * akceptowanych dla danego kodu kraju: pelna nazwa z COUNTRIES ORAZ wszystkie
 * wpisy z COUNTRY_VARIANTS[kod] (jesli sa). Uzywane w flagbattle.js zamiast
 * porownywania z jedna, sztywna nazwa.
 */
export function getWarianty(kod) {
  const nazwa = COUNTRIES[kod];
  const podstawa = nazwa ? [normalizeCountryName(nazwa)] : [];
  const dodatkowe = (COUNTRY_VARIANTS[kod] || []).map(normalizeCountryName);
  return [...new Set([...podstawa, ...dodatkowe])];
}

// Funkcja normalizująca nazwy (usuwająca polskie znaki diakrytyczne i duże litery).
// UWAGA: normalize('NFD') NIE rozkłada litery "ł" (nie ma dekompozycji NFD w
// Unikodzie - to nie jest litera "l" ze znakiem diakrytycznym, tylko osobny
// znak) - dlatego jest podmieniana jawnie, PRZED normalize('NFD'), inaczej
// "Słowenia"/"Włochy"/"Łotwa" nigdy nie trafiłyby we wzorzec bez ogonków.
export function normalizeCountryName(name) {
  return name
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/**
 * Dzieli znormalizowaną nazwę/odpowiedź na tablicę SŁÓW: każdy znak spoza
 * [a-z0-9] (spacje, interpunkcja, emotki, flagi-emoji - to wszystko spoza
 * zakresu) staje się separatorem, wielokrotne separatory są ściskane.
 * Używane zarówno do zbudowania INDEKSU_WARIANTOW (nazwy/warianty krajów są
 * już czystym tekstem, ale przechodzą tą samą funkcję dla spójności), jak i
 * do czyszczenia SUROWEJ odpowiedzi z czatu w flagbattle.js - patrz
 * tokenizujOdpowiedz nizej.
 */
function naSlowa(znormalizowanyTekst) {
  return znormalizowanyTekst
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Normalizuje i dzieli na słowa SUROWĄ odpowiedź z czatu (patrz naSlowa). */
export function tokenizujOdpowiedz(tekst) {
  return naSlowa(normalizeCountryName(tekst));
}

/**
 * Indeks WSZYSTKICH akceptowanych wariantow WSZYSTKICH krajow, rozbitych na
 * slowa - {kod, slowa}. Budowany RAZ przy ladowaniu modulu (nie przy kazdej
 * wiadomosci czatu - patrz uzycie w flagbattle.js), bo lista krajow/wariantow
 * jest stala przez cala sesje.
 */
export const INDEKS_WARIANTOW = COUNTRY_CODES.flatMap((kod) =>
  getWarianty(kod).map((wariant) => ({ kod, slowa: naSlowa(wariant) })),
).filter((wpis) => wpis.slowa.length > 0);
