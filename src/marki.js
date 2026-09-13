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
// Zaden wlasny kod normalizujacy/tokenizujacy - importujemy gotowe funkcje z
// countries.js (ten plik nie ma zadnych importow, wiec dalej dziala w golym
// node bez zaleznosci od reszty gry).
import { normalizeCountryName, tokenizujOdpowiedz } from './countries.js';

/**
 * slug (= nazwa pliku w assets/brands-vector/<slug>.svg bez rozszerzenia) ->
 * ladna nazwa wyswietlana. Zestaw slugow MUSI dokladnie pokrywac sie z
 * plikami w assets/brands-vector (zweryfikowane skryptem odczytujacym
 * katalog + <title> kazdego SVG, nie wpisane z pamieci - patrz raport z
 * weryfikacji przy tej zmianie). 222 marki.
 */
export const MARKI = {
  acer: "Acer",
  activision: "Activision",
  adidas: "Adidas",
  aeroflot: "Aeroflot",
  airbnb: "Airbnb",
  airfrance: "Air France",
  aldi: "Aldi Nord",
  aliexpress: "AliExpress",
  allegro: "Allegro",
  amd: "AMD",
  americanexpress: "American Express",
  android: "Android",
  apple: "Apple",
  applepay: "Apple Pay",
  appletv: "Apple TV",
  astonmartin: "Aston Martin",
  asus: "ASUS",
  auchan: "Auchan",
  audi: "Audi",
  avast: "Avast",
  beatsbydre: "Beats by Dre",
  bentley: "Bentley",
  binance: "Binance",
  bitcoin: "Bitcoin",
  bluesky: "Bluesky",
  bmw: "BMW",
  bookingcom: "Booking.com",
  bosch: "Bosch",
  bose: "Bose",
  britishairways: "British Airways",
  bugatti: "Bugatti",
  burgerking: "Burger King",
  cadillac: "Cadillac",
  carrefour: "Carrefour",
  castorama: "Castorama",
  chevrolet: "Chevrolet",
  chrysler: "Chrysler",
  chupachups: "Chupa Chups",
  citroen: "Citroën",
  cocacola: "Coca-Cola",
  coinbase: "Coinbase",
  corsair: "Corsair",
  counterstrike: "Counter-Strike",
  crunchyroll: "Crunchyroll",
  dacia: "Dacia",
  deezer: "Deezer",
  deliveroo: "Deliveroo",
  dell: "Dell",
  delta: "Delta",
  dhl: "DHL",
  discord: "Discord",
  dji: "DJI",
  dpd: "DPD",
  dropbox: "Dropbox",
  duckduckgo: "DuckDuckGo",
  duolingo: "Duolingo",
  ea: "EA",
  easyjet: "easyJet",
  ebay: "eBay",
  emirates: "Emirates",
  epicgames: "Epic Games",
  epson: "Epson",
  ethereum: "Ethereum",
  etsy: "Etsy",
  expedia: "Expedia",
  expressvpn: "ExpressVPN",
  facebook: "Facebook",
  fedex: "FedEx",
  ferrari: "Ferrari",
  fiat: "Fiat",
  fila: "Fila",
  firefoxbrowser: "Firefox Browser",
  fitbit: "Fitbit",
  flickr: "Flickr",
  ford: "Ford",
  fortnite: "Fortnite",
  garmin: "Garmin",
  glovo: "Glovo",
  google: "Google",
  googlechrome: "Google Chrome",
  googlepay: "Google Pay",
  hbo: "HBO",
  hm: "H&M",
  honda: "Honda",
  hp: "HP",
  huawei: "Huawei",
  hyundai: "Hyundai",
  ikea: "IKEA",
  instagram: "Instagram",
  intel: "Intel",
  ios: "iOS",
  jbl: "JBL",
  jeep: "Jeep",
  justeat: "Just Eat",
  kaspersky: "Kaspersky",
  kfc: "KFC",
  kia: "Kia",
  kickstarter: "Kickstarter",
  klarna: "Klarna",
  klm: "KLM",
  lamborghini: "Lamborghini",
  leagueoflegends: "League of Legends",
  lenovo: "Lenovo",
  leroymerlin: "Leroy Merlin",
  lg: "LG",
  lidl: "Lidl",
  line: "LINE",
  lot: "LOT Polish Airlines",
  lufthansa: "Lufthansa",
  maserati: "Maserati",
  mastercard: "MasterCard",
  max: "Max",
  mazda: "Mazda",
  mcafee: "McAfee",
  mcdonalds: "McDonald's",
  mini: "Mini",
  mitsubishi: "Mitsubishi",
  monsterenergy: "Monster",
  motorola: "Motorola",
  msi: "MSI",
  n26: "N26",
  netflix: "Netflix",
  newbalance: "New Balance",
  nike: "Nike",
  nikon: "Nikon",
  nissan: "Nissan",
  nokia: "Nokia",
  nordvpn: "NordVPN",
  norton: "Norton",
  norwegian: "Norwegian",
  nvidia: "NVIDIA",
  oneplus: "OnePlus",
  opel: "Opel",
  opera: "Opera",
  oppo: "OPPO",
  orange: "Orange",
  panasonic: "Panasonic",
  patreon: "Patreon",
  paypal: "PayPal",
  peugeot: "Peugeot",
  pinterest: "Pinterest",
  playstation: "PlayStation",
  porsche: "Porsche",
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
  samsung: "Samsung",
  seat: "SEAT",
  sharp: "sharp",
  shopify: "Shopify",
  siemens: "Siemens",
  signal: "Signal",
  sky: "Sky",
  smart: "smart",
  snapchat: "Snapchat",
  sony: "Sony",
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
  tesco: "Tesco",
  tesla: "Tesla",
  threads: "Threads",
  tidal: "TIDAL",
  tiktok: "TikTok",
  tinder: "Tinder",
  toshiba: "Toshiba",
  toyota: "Toyota",
  tripadvisor: "Tripadvisor",
  trivago: "trivago",
  turkishairlines: "Turkish Airlines",
  twitch: "Twitch",
  uber: "Uber",
  ubereats: "Uber Eats",
  ubisoft: "Ubisoft",
  underarmour: "Under Armour",
  uniqlo: "Uniqlo",
  ups: "UPS",
  valorant: "Valorant",
  viaplay: "Viaplay",
  viber: "Viber",
  vimeo: "Vimeo",
  vinted: "Vinted",
  visa: "Visa",
  vivo: "vivo",
  vodafone: "Vodafone",
  volkswagen: "Volkswagen",
  volvo: "Volvo",
  waze: "Waze",
  wechat: "WeChat",
  westernunion: "Western Union",
  whatsapp: "WhatsApp",
  wikipedia: "Wikipedia",
  wise: "Wise",
  wish: "Wish",
  wizzair: "Wizz Air",
  wordpress: "WordPress",
  x: "X",
  xiaomi: "Xiaomi",
  youtube: "YouTube",
  zabka: "Żabka",
  zalando: "Zalando",
  zara: "Zara",
  zoom: "Zoom",
};

export const MARKA_SLUGI = Object.keys(MARKI);

/**
 * Oficjalny kolor marki (atrybut fill="#RRGGBB" wstrzygniety w kazdym SVG)
 * dla kazdego slugu z MARKI - do pokolorowania UI minigry (np. tlo karty
 * logo). Odczytany z plikow, nie wymyslony.
 */
export const KOLORY_MAREK = {
  acer: "#83B81A",
  activision: "#000000",
  adidas: "#000000",
  aeroflot: "#02458D",
  airbnb: "#FF5A5F",
  airfrance: "#002157",
  aldi: "#2490D7",
  aliexpress: "#FF4747",
  allegro: "#FF5A00",
  amd: "#ED1C24",
  americanexpress: "#2E77BC",
  android: "#3DDC84",
  apple: "#000000",
  applepay: "#000000",
  appletv: "#000000",
  astonmartin: "#00665E",
  asus: "#000000",
  auchan: "#D6180B",
  audi: "#BB0A30",
  avast: "#FF7800",
  beatsbydre: "#E01F3D",
  bentley: "#333333",
  binance: "#F0B90B",
  bitcoin: "#F7931A",
  bluesky: "#1185FE",
  bmw: "#0066B1",
  bookingcom: "#003A9A",
  bosch: "#EA0016",
  bose: "#000000",
  britishairways: "#2E5C99",
  bugatti: "#000000",
  burgerking: "#D62300",
  cadillac: "#000000",
  carrefour: "#004E9F",
  castorama: "#0078D7",
  chevrolet: "#CD9834",
  chrysler: "#000000",
  chupachups: "#CF103E",
  citroen: "#DA291C",
  cocacola: "#D00013",
  coinbase: "#0052FF",
  corsair: "#231F20",
  counterstrike: "#000000",
  crunchyroll: "#FF5E00",
  dacia: "#646B52",
  deezer: "#A238FF",
  deliveroo: "#00CCBC",
  dell: "#007DB8",
  delta: "#003366",
  dhl: "#FFCC00",
  discord: "#5865F2",
  dji: "#000000",
  dpd: "#DC0032",
  dropbox: "#0061FF",
  duckduckgo: "#DE5833",
  duolingo: "#58CC02",
  ea: "#000000",
  easyjet: "#FF6600",
  ebay: "#E53238",
  emirates: "#D71921",
  epicgames: "#313131",
  epson: "#003399",
  ethereum: "#3C3C3D",
  etsy: "#F16521",
  expedia: "#191E3B",
  expressvpn: "#DA3940",
  facebook: "#0866FF",
  fedex: "#4D148C",
  ferrari: "#D40000",
  fiat: "#941711",
  fila: "#002D62",
  firefoxbrowser: "#FF7139",
  fitbit: "#00B0B9",
  flickr: "#0063DC",
  ford: "#00274E",
  fortnite: "#000000",
  garmin: "#000000",
  glovo: "#F2CC38",
  google: "#4285F4",
  googlechrome: "#4285F4",
  googlepay: "#4285F4",
  hbo: "#000000",
  hm: "#E50010",
  honda: "#E40521",
  hp: "#0096D6",
  huawei: "#FF0000",
  hyundai: "#002C5E",
  ikea: "#0058A3",
  instagram: "#FF0069",
  intel: "#0071C5",
  ios: "#000000",
  jbl: "#FF3300",
  jeep: "#000000",
  justeat: "#FF8000",
  kaspersky: "#006D5C",
  kfc: "#F40027",
  kia: "#05141F",
  kickstarter: "#05CE78",
  klarna: "#FFB3C7",
  klm: "#00A1DE",
  lamborghini: "#B6A272",
  leagueoflegends: "#C28F2C",
  lenovo: "#E2231A",
  leroymerlin: "#78BE20",
  lg: "#A50034",
  lidl: "#0050AA",
  line: "#00C300",
  lot: "#11397E",
  lufthansa: "#05164D",
  maserati: "#0C2340",
  mastercard: "#EB001B",
  max: "#525252",
  mazda: "#101010",
  mcafee: "#C01818",
  mcdonalds: "#FBC817",
  mini: "#000000",
  mitsubishi: "#E60012",
  monsterenergy: "#6D4C9F",
  motorola: "#E1140A",
  msi: "#FF0000",
  n26: "#48AC98",
  netflix: "#E50914",
  newbalance: "#CF0A2C",
  nike: "#111111",
  nikon: "#FFE100",
  nissan: "#C3002F",
  nokia: "#005AFF",
  nordvpn: "#4687FF",
  norton: "#FFE01A",
  norwegian: "#D81939",
  nvidia: "#76B900",
  oneplus: "#F5010C",
  opel: "#F7FF14",
  opera: "#FF1B2D",
  oppo: "#2D683D",
  orange: "#FF7900",
  panasonic: "#0049AB",
  patreon: "#000000",
  paypal: "#002991",
  peugeot: "#000000",
  pinterest: "#BD081C",
  playstation: "#0070D1",
  porsche: "#B12B28",
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
  samsung: "#1428A0",
  seat: "#33302E",
  sharp: "#99CC00",
  shopify: "#7AB55C",
  siemens: "#009999",
  signal: "#3B45FD",
  sky: "#0072C9",
  smart: "#D7E600",
  snapchat: "#FFFC00",
  sony: "#FFFFFF",
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
  tesco: "#00539F",
  tesla: "#CC0000",
  threads: "#000000",
  tidal: "#000000",
  tiktok: "#000000",
  tinder: "#FF6B6B",
  toshiba: "#FF0000",
  toyota: "#EB0A1E",
  tripadvisor: "#34E0A1",
  trivago: "#E32851",
  turkishairlines: "#C70A0C",
  twitch: "#9146FF",
  uber: "#000000",
  ubereats: "#06C167",
  ubisoft: "#000000",
  underarmour: "#1D1D1D",
  uniqlo: "#FF0000",
  ups: "#150400",
  valorant: "#FA4454",
  viaplay: "#FE365F",
  viber: "#7360F2",
  vimeo: "#1AB7EA",
  vinted: "#007782",
  visa: "#1A1F71",
  vivo: "#415FFF",
  vodafone: "#E60000",
  volkswagen: "#151F5D",
  volvo: "#003057",
  waze: "#33CCFF",
  wechat: "#07C160",
  westernunion: "#FFDD00",
  whatsapp: "#25D366",
  wikipedia: "#000000",
  wise: "#9FE870",
  wish: "#32E476",
  wizzair: "#C6007E",
  wordpress: "#21759B",
  x: "#000000",
  xiaomi: "#FF6900",
  youtube: "#FF0000",
  zabka: "#006420",
  zalando: "#FF6900",
  zara: "#000000",
  zoom: "#0B5CFF",
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
  burgerking: ['bk'],
  kfc: ['kentucky', 'kentucky fried chicken'],
  cocacola: ['cola', 'coca cola', 'koka kola'],
  starbucks: ['sbux'],
  hm: ['hm', 'h and m'],
  googlechrome: ['chrome'],
  googlepay: ['gpay', 'google pay'],
  applepay: ['apple pay'],
  appletv: ['apple tv'],
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
  epicgames: ['epic'],
  ea: ['electronic arts'],
  soundcloud: ['sc'],
  x: ['twitter'],
  max: ['hbo max'],
  bitcoin: ['btc'],
  ethereum: ['eth'],
  britishairways: ['ba'],
  wizzair: ['wizz'],
  volkswagen: ['vw'],
  rollsroyce: ['rolls royce'],
  astonmartin: ['aston martin'],
  americanexpress: ['amex'],
  playstation: ['ps'],
  bookingcom: ['booking'],
  duckduckgo: ['ddg'],
  beatsbydre: ['beats'],
  underarmour: ['ua'],
  newbalance: ['nb'],
  westernunion: ['western union', 'wu'],
  ubereats: ['uber eats'],
  justeat: ['just eat'],
  leroymerlin: ['leroy merlin'],
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
