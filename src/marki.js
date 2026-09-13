// src/marki.js
// Dane minigry "Zgadnij marke" (logotypy zamiast flag panstw) - wzorem
// src/countries.js (tam: kraj -> warianty nazwy). Sama minigra NIE jest tu
// pisana ani podpinana - to wylacznie modul danych.
//
// Zrodlo plikow SVG: assets/brands-vector/*.svg, zbior logotypow
// simple-icons (https://simpleicons.org), udostepniony na licencji CC0 1.0
// (domena publiczna) - patrz assets/brands-vector/ATRYBUCJA.txt. Same znaki
// towarowe/nazwy marek pozostaja wlasnoscia ich wlascicieli, licencja
// dotyczy WYLACZNIE plikow SVG (ksztaltu logo), nie prawa do marki.
//
// Zestaw zawiera WYLACZNIE znaki graficzne (symbole/monogramy) - celowo BEZ
// logotypow, ktore maja nazwe marki wypisana literami, bo to zdradzaloby
// odpowiedz na obrazku. 149 marek.
//
// Zaden wlasny kod normalizujacy/tokenizujacy - importujemy gotowe funkcje z
// countries.js (ten plik nie ma zadnych importow, wiec dalej dziala w golym
// node bez zaleznosci od reszty gry).
import { normalizeCountryName, tokenizujOdpowiedz } from './countries.js';

/**
 * slug (= nazwa pliku w assets/brands-vector/<slug>.svg bez rozszerzenia) ->
 * ladna nazwa wyswietlana. Zestaw slugow MUSI dokladnie pokrywac sie z
 * plikami w assets/brands-vector (zweryfikowane skryptem odczytujacym
 * katalog + <title> kazdego SVG, nie wpisane z pamieci - patrz raport z
 * weryfikacji przy tej zmianie). 149 marek.
 */
export const MARKI = {
  adidas: "Adidas",
  aeroflot: "Aeroflot",
  airbnb: "Airbnb",
  airfrance: "Air France",
  android: "Android",
  apple: "Apple",
  auchan: "Auchan",
  audi: "Audi",
  avast: "Avast",
  beatsbydre: "Beats by Dre",
  bentley: "Bentley",
  binance: "Binance",
  bitcoin: "Bitcoin",
  bluesky: "Bluesky",
  bookingcom: "Booking.com",
  bosch: "Bosch",
  britishairways: "British Airways",
  bugatti: "Bugatti",
  cadillac: "Cadillac",
  carrefour: "Carrefour",
  castorama: "Castorama",
  chevrolet: "Chevrolet",
  chrysler: "Chrysler",
  chupachups: "Chupa Chups",
  citroen: "Citroën",
  cocacola: "Coca-Cola",
  corsair: "Corsair",
  counterstrike: "Counter-Strike",
  crunchyroll: "Crunchyroll",
  dacia: "Dacia",
  deezer: "Deezer",
  deliveroo: "Deliveroo",
  discord: "Discord",
  dpd: "DPD",
  dropbox: "Dropbox",
  duckduckgo: "DuckDuckGo",
  duolingo: "Duolingo",
  emirates: "Emirates",
  ethereum: "Ethereum",
  etsy: "Etsy",
  expedia: "Expedia",
  expressvpn: "ExpressVPN",
  facebook: "Facebook",
  ferrari: "Ferrari",
  firefoxbrowser: "Firefox Browser",
  fitbit: "Fitbit",
  flickr: "Flickr",
  fortnite: "Fortnite",
  glovo: "Glovo",
  google: "Google",
  googlechrome: "Google Chrome",
  honda: "Honda",
  huawei: "Huawei",
  hyundai: "Hyundai",
  instagram: "Instagram",
  justeat: "Just Eat",
  kickstarter: "Kickstarter",
  klarna: "Klarna",
  lamborghini: "Lamborghini",
  leagueoflegends: "League of Legends",
  lot: "LOT Polish Airlines",
  lufthansa: "Lufthansa",
  maserati: "Maserati",
  mastercard: "MasterCard",
  max: "Max",
  mazda: "Mazda",
  mcafee: "McAfee",
  mcdonalds: "McDonald's",
  mitsubishi: "Mitsubishi",
  monsterenergy: "Monster",
  motorola: "Motorola",
  msi: "MSI",
  netflix: "Netflix",
  newbalance: "New Balance",
  nike: "Nike",
  nordvpn: "NordVPN",
  norton: "Norton",
  norwegian: "Norwegian",
  nvidia: "NVIDIA",
  oneplus: "OnePlus",
  opel: "Opel",
  opera: "Opera",
  orange: "Orange",
  patreon: "Patreon",
  paypal: "PayPal",
  pinterest: "Pinterest",
  playstation: "PlayStation",
  puma: "Puma",
  qatarairways: "Qatar Airways",
  quora: "Quora",
  razer: "Razer",
  redbull: "Red Bull",
  reddit: "Reddit",
  reebok: "Reebok",
  renault: "Renault",
  revolut: "Revolut",
  riotgames: "Riot Games",
  roblox: "Roblox",
  rockstargames: "Rockstar Games",
  rollsroyce: "Rolls-Royce",
  rossmann: "Rossmann",
  ryanair: "Ryanair",
  seat: "SEAT",
  sharp: "sharp",
  shopify: "Shopify",
  signal: "Signal",
  smart: "smart",
  snapchat: "Snapchat",
  soundcloud: "SoundCloud",
  spotify: "Spotify",
  starbucks: "Starbucks",
  steam: "Steam",
  steelseries: "Steelseries",
  stripe: "Stripe",
  subaru: "Subaru",
  suzuki: "Suzuki",
  target: "Target",
  telegram: "Telegram",
  tesla: "Tesla",
  threads: "Threads",
  tidal: "TIDAL",
  tiktok: "TikTok",
  tinder: "Tinder",
  toyota: "Toyota",
  tripadvisor: "Tripadvisor",
  trivago: "trivago",
  turkishairlines: "Turkish Airlines",
  twitch: "Twitch",
  ubisoft: "Ubisoft",
  underarmour: "Under Armour",
  uniqlo: "Uniqlo",
  valorant: "Valorant",
  viaplay: "Viaplay",
  viber: "Viber",
  vimeo: "Vimeo",
  vinted: "Vinted",
  vodafone: "Vodafone",
  volkswagen: "Volkswagen",
  waze: "Waze",
  wechat: "WeChat",
  westernunion: "Western Union",
  whatsapp: "WhatsApp",
  wikipedia: "Wikipedia",
  wise: "Wise",
  wish: "Wish",
  wordpress: "WordPress",
  xiaomi: "Xiaomi",
  youtube: "YouTube",
  zalando: "Zalando",
};

export const MARKA_SLUGI = Object.keys(MARKI);

/**
 * Oficjalny kolor marki (atrybut fill="#RRGGBB" wstrzygniety w kazdym SVG)
 * dla kazdego slugu z MARKI - do pokolorowania UI minigry (np. tlo karty
 * logo). Odczytany z plikow, nie wymyslony.
 */
export const KOLORY_MAREK = {
  adidas: "#000000",
  aeroflot: "#02458D",
  airbnb: "#FF5A5F",
  airfrance: "#002157",
  android: "#3DDC84",
  apple: "#000000",
  auchan: "#D6180B",
  audi: "#BB0A30",
  avast: "#FF7800",
  beatsbydre: "#E01F3D",
  bentley: "#333333",
  binance: "#F0B90B",
  bitcoin: "#F7931A",
  bluesky: "#1185FE",
  bookingcom: "#003A9A",
  bosch: "#EA0016",
  britishairways: "#2E5C99",
  bugatti: "#000000",
  cadillac: "#000000",
  carrefour: "#004E9F",
  castorama: "#0078D7",
  chevrolet: "#CD9834",
  chrysler: "#000000",
  chupachups: "#CF103E",
  citroen: "#DA291C",
  cocacola: "#D00013",
  corsair: "#231F20",
  counterstrike: "#000000",
  crunchyroll: "#FF5E00",
  dacia: "#646B52",
  deezer: "#A238FF",
  deliveroo: "#00CCBC",
  discord: "#5865F2",
  dpd: "#DC0032",
  dropbox: "#0061FF",
  duckduckgo: "#DE5833",
  duolingo: "#58CC02",
  emirates: "#D71921",
  ethereum: "#3C3C3D",
  etsy: "#F16521",
  expedia: "#191E3B",
  expressvpn: "#DA3940",
  facebook: "#0866FF",
  ferrari: "#D40000",
  firefoxbrowser: "#FF7139",
  fitbit: "#00B0B9",
  flickr: "#0063DC",
  fortnite: "#000000",
  glovo: "#F2CC38",
  google: "#4285F4",
  googlechrome: "#4285F4",
  honda: "#E40521",
  huawei: "#FF0000",
  hyundai: "#002C5E",
  instagram: "#FF0069",
  justeat: "#FF8000",
  kickstarter: "#05CE78",
  klarna: "#FFB3C7",
  lamborghini: "#B6A272",
  leagueoflegends: "#C28F2C",
  lot: "#11397E",
  lufthansa: "#05164D",
  maserati: "#0C2340",
  mastercard: "#EB001B",
  max: "#525252",
  mazda: "#101010",
  mcafee: "#C01818",
  mcdonalds: "#FBC817",
  mitsubishi: "#E60012",
  monsterenergy: "#6D4C9F",
  motorola: "#E1140A",
  msi: "#FF0000",
  netflix: "#E50914",
  newbalance: "#CF0A2C",
  nike: "#111111",
  nordvpn: "#4687FF",
  norton: "#FFE01A",
  norwegian: "#D81939",
  nvidia: "#76B900",
  oneplus: "#F5010C",
  opel: "#F7FF14",
  opera: "#FF1B2D",
  orange: "#FF7900",
  patreon: "#000000",
  paypal: "#002991",
  pinterest: "#BD081C",
  playstation: "#0070D1",
  puma: "#242B2F",
  qatarairways: "#5C0D34",
  quora: "#B92B27",
  razer: "#00FF00",
  redbull: "#DB0A40",
  reddit: "#FF4500",
  reebok: "#E41D1B",
  renault: "#FFCC33",
  revolut: "#191C1F",
  riotgames: "#EB0029",
  roblox: "#000000",
  rockstargames: "#FCAF17",
  rollsroyce: "#281432",
  rossmann: "#C3002D",
  ryanair: "#073590",
  seat: "#33302E",
  sharp: "#99CC00",
  shopify: "#7AB55C",
  signal: "#3B45FD",
  smart: "#D7E600",
  snapchat: "#FFFC00",
  soundcloud: "#FF5500",
  spotify: "#1ED760",
  starbucks: "#006241",
  steam: "#000000",
  steelseries: "#FF5200",
  stripe: "#635BFF",
  subaru: "#013C74",
  suzuki: "#E30613",
  target: "#CC0000",
  telegram: "#26A5E4",
  tesla: "#CC0000",
  threads: "#000000",
  tidal: "#000000",
  tiktok: "#000000",
  tinder: "#FF6B6B",
  toyota: "#EB0A1E",
  tripadvisor: "#34E0A1",
  trivago: "#E32851",
  turkishairlines: "#C70A0C",
  twitch: "#9146FF",
  ubisoft: "#000000",
  underarmour: "#1D1D1D",
  uniqlo: "#FF0000",
  valorant: "#FA4454",
  viaplay: "#FE365F",
  viber: "#7360F2",
  vimeo: "#1AB7EA",
  vinted: "#007782",
  vodafone: "#E60000",
  volkswagen: "#151F5D",
  waze: "#33CCFF",
  wechat: "#07C160",
  westernunion: "#FFDD00",
  whatsapp: "#25D366",
  wikipedia: "#000000",
  wise: "#9FE870",
  wish: "#32E476",
  wordpress: "#21759B",
  xiaomi: "#FF6900",
  youtube: "#FF0000",
  zalando: "#FF6900",
};

/**
 * Dodatkowe akceptowane warianty odpowiedzi na czacie, poza pelna nazwa z
 * MARKI (ta zawsze jest akceptowana automatycznie - patrz getWariantyMarki
 * nizej). Tylko realne, potocznie uzywane zapisy - skroty, spolszczenia,
 * zapisy bez spacji/apostrofow. Wiekszosc marek NIE ma tu wpisu: sama pelna
 * nazwa (np. "nike", "adidas", "spotify") wystarcza, wiec nie ma sensu
 * wymyslac wariantow, ktorych nikt na czacie i tak by nie uzyl (wzorem
 * podejscia w countries.js).
 *
 * UWAGA o niejednoznacznosci: tak jak w COUNTRY_VARIANTS, celowo NIE
 * dodajemy wariantu, ktory pasowalby do wiecej niz jednej marki z MARKI.
 * Sprawdzone w tym zbiorze: zaden ponizszy wariant nie powtarza sie ani
 * miedzy wpisami tutaj, ani z PELNA nazwa jakiejkolwiek innej marki -
 * zweryfikowane automatycznie przez walidacje przy ladowaniu modulu nizej.
 * Przyklad z ktorym trzeba uwazac: "orange" jest w tym zbiorze WYLACZNIE
 * marka (slug "orange") - gdyby kiedys dolaczyla marka o nazwie
 * kolidujacej ze zwyklym slowem, rozstrzygamy w danych (usuwamy albo
 * przypisujemy jednoznacznie), nie w kodzie walidacji.
 */
export const MARKA_WARIANTY = {
  mcdonalds: ['mcdonald', 'macdonalds', 'maca', 'mekdonald', 'mekdonalds'],
  cocacola: ['cola', 'coca cola', 'koka kola'],
  starbucks: ['sbux'],
  googlechrome: ['chrome'],
  youtube: ['yt'],
  whatsapp: ['wsp', 'whats app'],
  facebook: ['fb'],
  instagram: ['insta', 'ig'],
  tiktok: ['tik tok'],
  snapchat: ['snap'],
  leagueoflegends: ['league'],
  counterstrike: ['cs', 'csgo', 'cs go'],
  riotgames: ['riot'],
  rockstargames: ['rockstar'],
  soundcloud: ['sc'],
  max: ['hbo max'],
  bitcoin: ['btc'],
  ethereum: ['eth'],
  britishairways: ['ba'],
  volkswagen: ['vw'],
  rollsroyce: ['rolls royce'],
  playstation: ['ps'],
  bookingcom: ['booking'],
  duckduckgo: ['ddg'],
  beatsbydre: ['beats'],
  underarmour: ['ua'],
  newbalance: ['nb'],
  westernunion: ['western union', 'wu'],
  justeat: ['just eat'],
};

/**
 * Zwraca liste ZNORMALIZOWANYCH (normalizeCountryName) wariantow odpowiedzi
 * akceptowanych dla danego slugu marki: pelna nazwa z MARKI ORAZ wszystkie
 * wpisy z MARKA_WARIANTY[slug] (jesli sa). Dokladny odpowiednik getWarianty
 * z countries.js.
 */
export function getWariantyMarki(slug) {
  const nazwa = MARKI[slug];
  const podstawa = nazwa ? [normalizeCountryName(nazwa)] : [];
  const dodatkowe = (MARKA_WARIANTY[slug] || []).map(normalizeCountryName);
  return [...new Set([...podstawa, ...dodatkowe])];
}

/**
 * Normalizuje i dzieli na slowa SUROWA odpowiedz z czatu - dokladny
 * odpowiednik tokenizujOdpowiedz z countries.js (ta sama funkcja, tylko pod
 * nazwa spojna z reszta tego modulu).
 */
export function tokenizujOdpowiedzMarki(tekst) {
  return tokenizujOdpowiedz(tekst);
}

/**
 * Indeks WSZYSTKICH akceptowanych wariantow WSZYSTKICH marek, rozbitych na
 * slowa - {slug, slowa}. Budowany RAZ przy ladowaniu modulu (nie przy kazdej
 * wiadomosci czatu), bo lista marek/wariantow jest stala przez cala sesje.
 * Dokladny odpowiednik INDEKS_WARIANTOW z countries.js.
 */
export const INDEKS_WARIANTOW_MAREK = MARKA_SLUGI.flatMap((slug) =>
  getWariantyMarki(slug).map((wariant) => ({ slug, slowa: tokenizujOdpowiedz(wariant) })),
).filter((wpis) => wpis.slowa.length > 0);

/**
 * Walidacja integralnosci danych, rzucajaca wyjatkiem PRZY LADOWANIU MODULU
 * (wzorem sprawdzenia duplikatow w slowka.js) - lepiej niech gra sie nie
 * odpali w ogole, niz zeby dwuznaczny wariant wywolal sporny werdykt na
 * streamie:
 * (a) brak duplikatow slugow w MARKI (Object w JS by je i tak scichadu
 *     nadpisal, wiec sprawdzamy zrodlowa liczbe kluczy),
 * (b) kazdy slug z MARKI ma wpis w KOLORY_MAREK,
 * (c) zaden wariant (po tokenizacji na slowa) nie jest przypisany do dwoch
 *     roznych marek - to jest NAJWAZNIEJSZY punkt, bo dwuznaczna odpowiedz
 *     na czacie to gwarantowana klotnia o punkt.
 */
{
  // (a) - Object.keys nie moze miec duplikatow z definicji literalu, ale
  // gdyby ktos w przyszlosci budowal MARKI programowo, ten warunek to
  // wylapie (dlugosc kluczy == dlugosc unikalnych kluczy).
  const unikalneSlugi = new Set(MARKA_SLUGI);
  if (unikalneSlugi.size !== MARKA_SLUGI.length) {
    throw new Error('[marki] Zduplikowane slugi w MARKI.');
  }

  // (b)
  for (const slug of MARKA_SLUGI) {
    if (!KOLORY_MAREK[slug]) {
      throw new Error(`[marki] Brak koloru w KOLORY_MAREK dla marki "${slug}".`);
    }
  }

  // (c) - klucz kolizji to zlaczony ciag slow (np. "coca cola"), bo
  // pojedyncze wspolne slowo (np. "air" w "air france" i hipotetycznym
  // "air max") nie jest kolizja - kolizja to identyczna PELNA sekwencja
  // slow wskazujaca na dwie rozne marki.
  const wlasciciel = new Map(); // "slowo1 slowo2" -> slug
  for (const { slug, slowa } of INDEKS_WARIANTOW_MAREK) {
    const klucz = slowa.join(' ');
    const poprzedni = wlasciciel.get(klucz);
    if (poprzedni && poprzedni !== slug) {
      throw new Error(
        `[marki] Dwuznaczny wariant "${klucz}": pasuje jednoczesnie do marek "${poprzedni}" i "${slug}".`,
      );
    }
    wlasciciel.set(klucz, slug);
  }
}
