// src/panstwa-miasta-dane.js
// Dane minigry "Panstwa-Miasta": trzy kategorie (PANSTWO / IMIE / OWOC),
// losowana litera, gracze odpowiadaja na czacie. Wzorem src/countries.js
// (struktura danych + normalizacja) i src/slowka.js (walidacja przy
// ladowaniu modulu zamiast recznego przeliczania).
//
// Kategoria PANSTWO NIE dubluje listy krajow - korzysta w calosci z danych
// juz istniejacych w countries.js (COUNTRIES/INDEKS_WARIANTOW). IMIONA i
// OWOCE sa wlasnymi listami tego modulu, bo countries.js ich nie ma.
//
// Modul nie ma zadnych zaleznosci poza './countries.js' (ktora sama nie ma
// zadnych importow) - da sie go odpalic w golym node, bez przegladarki i
// bez reszty gry.
import {
  COUNTRIES,
  COUNTRY_CODES,
  normalizeCountryName,
  tokenizujOdpowiedz,
  INDEKS_WARIANTOW,
} from './countries.js';

export const KATEGORIE = [
  { id: 'panstwo', etykieta: 'Państwo' },
  { id: 'imie', etykieta: 'Imię' },
  { id: 'owoc', etykieta: 'Owoc' },
];

// --- IMIONA -----------------------------------------------------------
// Co najmniej 150 najpopularniejszych polskich imion (meskich i zenskich),
// takich jakie polski czat streamu realnie zna. Kazdy wpis: [id, nazwa,
// warianty?] - id to slug bez polskich znakow (uzywany do wykrywania
// powtorzen przez gre), nazwa to pelna forma do wyswietlenia, warianty to
// OCZYWISTE zdrobnienia/przezwiska (nie trzeba tu wpisywac wersji bez
// polskich znakow - normalizeCountryName usuwa je automatycznie przy
// porownaniu, wiec "Łukasz" i wpisana na czacie "lukasz" i tak trafiaja w
// ten sam wpis).
const IMIONA_RAW = [
  // --- A ---
  ['adam', 'Adam'],
  ['adrian', 'Adrian'],
  ['agata', 'Agata'],
  ['agnieszka', 'Agnieszka', ['aga']],
  ['aleksander', 'Aleksander', ['olek', 'alek']],
  ['aleksandra', 'Aleksandra', ['ola', 'ala']],
  ['alicja', 'Alicja'],
  ['amelia', 'Amelia'],
  ['anna', 'Anna', ['ania']],
  ['antoni', 'Antoni'],
  ['antonina', 'Antonina'],
  ['artur', 'Artur'],
  // --- B ---
  ['barbara', 'Barbara', ['basia']],
  ['bartosz', 'Bartosz', ['bartek']],
  ['beata', 'Beata'],
  ['bogdan', 'Bogdan'],
  ['bozena', 'Bożena'],
  ['brygida', 'Brygida'],
  ['bogumila', 'Bogumiła'],
  // --- C ---
  ['cecylia', 'Cecylia'],
  ['cezary', 'Cezary', ['czarek']],
  ['celina', 'Celina'],
  // --- D ---
  ['damian', 'Damian'],
  ['daniel', 'Daniel', ['danek']],
  ['danuta', 'Danuta'],
  ['dariusz', 'Dariusz', ['darek']],
  ['dominik', 'Dominik'],
  ['dominika', 'Dominika'],
  ['dorota', 'Dorota'],
  ['dawid', 'Dawid'],
  // --- E ---
  ['edward', 'Edward', ['edek']],
  ['elzbieta', 'Elżbieta', ['ela']],
  ['emilia', 'Emilia'],
  ['ewa', 'Ewa'],
  ['ewelina', 'Ewelina'],
  ['eugeniusz', 'Eugeniusz'],
  // --- F ---
  ['filip', 'Filip'],
  ['franciszek', 'Franciszek', ['franek']],
  ['feliks', 'Feliks'],
  // --- G ---
  ['gabriela', 'Gabriela', ['gabrysia']],
  ['grazyna', 'Grażyna'],
  ['grzegorz', 'Grzegorz', ['grzesiek']],
  ['gustaw', 'Gustaw'],
  // --- H ---
  ['halina', 'Halina'],
  ['hanna', 'Hanna', ['hania']],
  ['henryk', 'Henryk', ['henio']],
  ['hubert', 'Hubert'],
  ['helena', 'Helena'],
  // --- I ---
  ['ignacy', 'Ignacy'],
  ['irena', 'Irena'],
  ['iwona', 'Iwona'],
  ['izabela', 'Izabela', ['iza']],
  ['ida', 'Ida'],
  // --- J ---
  ['jacek', 'Jacek'],
  ['jadwiga', 'Jadwiga', ['jadzia']],
  ['jakub', 'Jakub', ['kuba']],
  ['jan', 'Jan', ['janek']],
  ['janina', 'Janina'],
  ['janusz', 'Janusz'],
  ['jerzy', 'Jerzy', ['jurek']],
  ['joanna', 'Joanna', ['asia']],
  ['jolanta', 'Jolanta', ['jola']],
  ['jozef', 'Józef', ['jozek']],
  ['julia', 'Julia'],
  ['julian', 'Julian'],
  ['justyna', 'Justyna'],
  ['jaroslaw', 'Jarosław', ['jarek']],
  // --- K ---
  ['kacper', 'Kacper'],
  ['karol', 'Karol'],
  ['karolina', 'Karolina'],
  ['katarzyna', 'Katarzyna', ['kasia']],
  ['kazimierz', 'Kazimierz', ['kazik']],
  ['kinga', 'Kinga'],
  ['konrad', 'Konrad'],
  ['krystian', 'Krystian'],
  ['krystyna', 'Krystyna', ['krysia']],
  ['krzysztof', 'Krzysztof', ['krzysiek']],
  ['klaudia', 'Klaudia'],
  // --- L (Ł normalizuje sie do L - patrz normalizeCountryName) ---
  ['leon', 'Leon'],
  ['leszek', 'Leszek'],
  ['liliana', 'Liliana'],
  ['lucyna', 'Lucyna'],
  ['ludwik', 'Ludwik'],
  ['lidia', 'Lidia'],
  ['lukasz', 'Łukasz'],
  ['leonard', 'Leonard'],
  // --- M ---
  ['maciej', 'Maciej', ['maciek']],
  ['magdalena', 'Magdalena', ['magda']],
  ['malwina', 'Malwina'],
  ['marcin', 'Marcin'],
  ['marek', 'Marek'],
  ['maria', 'Maria', ['marysia']],
  ['marian', 'Marian'],
  ['marianna', 'Marianna'],
  ['mariusz', 'Mariusz'],
  ['marlena', 'Marlena'],
  ['marta', 'Marta'],
  ['martyna', 'Martyna'],
  ['mateusz', 'Mateusz'],
  ['michal', 'Michał'],
  ['michalina', 'Michalina'],
  ['mieczyslaw', 'Mieczysław', ['mietek']],
  ['mikolaj', 'Mikołaj'],
  ['milena', 'Milena'],
  ['miroslaw', 'Mirosław', ['mirek']],
  ['monika', 'Monika'],
  // --- N ---
  ['natalia', 'Natalia'],
  ['nikodem', 'Nikodem'],
  ['nikola', 'Nikola'],
  ['norbert', 'Norbert'],
  ['nina', 'Nina'],
  // --- O ---
  ['oliwia', 'Oliwia'],
  ['oskar', 'Oskar'],
  ['olga', 'Olga'],
  // --- P ---
  ['patryk', 'Patryk'],
  ['paulina', 'Paulina'],
  ['pawel', 'Paweł'],
  ['piotr', 'Piotr', ['piotrek']],
  ['przemyslaw', 'Przemysław', ['przemek']],
  ['patrycja', 'Patrycja'],
  // --- R ---
  ['rafal', 'Rafał'],
  ['renata', 'Renata'],
  ['robert', 'Robert'],
  ['roman', 'Roman'],
  ['roksana', 'Roksana'],
  ['ryszard', 'Ryszard', ['rysiek']],
  ['radoslaw', 'Radosław', ['radek']],
  // --- S ---
  ['sabina', 'Sabina'],
  ['sandra', 'Sandra'],
  ['sebastian', 'Sebastian', ['sebek']],
  ['slawomir', 'Sławomir', ['slawek']],
  ['stanislaw', 'Stanisław', ['stasiek', 'stach']],
  ['stefan', 'Stefan'],
  ['sylwester', 'Sylwester', ['sylwek']],
  ['sylwia', 'Sylwia'],
  ['szymon', 'Szymon'],
  // --- T ---
  ['tadeusz', 'Tadeusz', ['tadek']],
  ['tomasz', 'Tomasz', ['tomek']],
  // --- U ---
  ['urszula', 'Urszula', ['ula']],
  // --- W ---
  ['waldemar', 'Waldemar', ['waldek']],
  ['weronika', 'Weronika', ['wera']],
  ['wiktor', 'Wiktor'],
  ['wiktoria', 'Wiktoria', ['wika']],
  ['wieslaw', 'Wiesław', ['wiesiek']],
  ['wioletta', 'Wioletta', ['wiola']],
  ['witold', 'Witold'],
  ['wladyslaw', 'Władysław', ['wladek']],
  ['wojciech', 'Wojciech', ['wojtek']],
  ['wanda', 'Wanda'],
  // --- Z (Ż normalizuje sie do Z) ---
  ['zbigniew', 'Zbigniew', ['zbyszek']],
  ['zdzislaw', 'Zdzisław', ['zdzisiek']],
  ['zenon', 'Zenon'],
  ['zofia', 'Zofia', ['zosia']],
  ['zuzanna', 'Zuzanna', ['zuzia']],
  ['zygmunt', 'Zygmunt'],
  ['zaneta', 'Żaneta'],
  ['zdzislawa', 'Zdzisława'],
];

// --- OWOCE --------------------------------------------------------------
// Co najmniej 60 owocow znanych w Polsce. Osobne, ROZNE owoce (np.
// mandarynka/klementynka) dostaja OSOBNE wpisy - warianty sa tylko dla
// prawdziwych synonimow tej samej rosliny (np. aronia = czarna jarzebina).
const OWOCE_RAW = [
  ['jablko', 'Jabłko'],
  ['gruszka', 'Gruszka'],
  ['banan', 'Banan'],
  ['pomarancza', 'Pomarańcza'],
  ['mandarynka', 'Mandarynka'],
  ['klementynka', 'Klementynka'],
  ['cytryna', 'Cytryna'],
  ['limonka', 'Limonka'],
  ['grejpfrut', 'Grejpfrut'],
  ['winogrono', 'Winogrono'],
  ['truskawka', 'Truskawka'],
  ['malina', 'Malina'],
  ['jezyna', 'Jeżyna'],
  ['borowka', 'Borówka', ['jagoda']],
  ['poziomka', 'Poziomka'],
  ['agrest', 'Agrest'],
  ['porzeczka', 'Porzeczka'],
  ['wisnia', 'Wiśnia'],
  ['czeresnia', 'Czereśnia'],
  ['sliwka', 'Śliwka'],
  ['morela', 'Morela'],
  ['brzoskwinia', 'Brzoskwinia'],
  ['nektarynka', 'Nektarynka'],
  ['arbuz', 'Arbuz'],
  ['melon', 'Melon'],
  ['kiwi', 'Kiwi'],
  ['ananas', 'Ananas'],
  ['mango', 'Mango'],
  ['papaja', 'Papaja'],
  ['awokado', 'Awokado'],
  ['granat', 'Granat'],
  ['figa', 'Figa'],
  ['daktyl', 'Daktyl'],
  ['kokos', 'Kokos'],
  ['liczi', 'Liczi'],
  ['marakuja', 'Marakuja'],
  ['guawa', 'Guawa'],
  ['karambola', 'Karambola'],
  ['pigwa', 'Pigwa'],
  ['zurawina', 'Żurawina'],
  ['aronia', 'Aronia', ['czarna jarzebina']],
  ['morwa', 'Morwa'],
  ['rabarbar', 'Rabarbar'],
  ['pomelo', 'Pomelo'],
  ['kumkwat', 'Kumkwat'],
  ['durian', 'Durian'],
  ['rambutan', 'Rambutan'],
  ['pitaja', 'Pitaja', ['smoczy owoc', 'dragon fruit']],
  ['dynia', 'Dynia'],
  ['oliwka', 'Oliwka'],
  ['kaki', 'Kaki', ['persymona']],
  ['nashi', 'Nashi', ['gruszka azjatycka']],
  ['opuncja', 'Opuncja', ['figa indyjska']],
  ['jarzebina', 'Jarzębina'],
  ['dzika-roza', 'Dzika róża', ['owoc dzikiej rozy', 'owoc rozy']],
  ['glog', 'Głóg'],
  ['mirabelka', 'Mirabelka'],
  ['renkloda', 'Renkloda'],
  ['bergamotka', 'Bergamotka'],
  ['physalis', 'Physalis', ['miechunka']],
  ['goji', 'Goji', ['jagody goji']],
  ['acerola', 'Acerola'],
  ['kiwano', 'Kiwano'],
  ['acai', 'Acai'],
  ['tarnina', 'Tarnina'],
  ['sapodilla', 'Sapodilla'],
];

/**
 * Buduje liste {id, nazwa, warianty} z surowych wpisow [id, nazwa, warianty?]
 * i RZUCA WYJATKIEM przy zduplikowanym id - ten sam idiom co walidacja RAW w
 * slowka.js (silniejsza gwarancja niz reczne przeliczanie), bo id sluzy grze
 * do wykrywania powtorzonych odpowiedzi i musi byc unikalne.
 */
function zbudujListe(raw, etykieta) {
  const widziane = new Set();
  const lista = [];
  for (const [id, nazwa, warianty] of raw) {
    if (widziane.has(id)) {
      throw new Error(`[panstwa-miasta-dane] Zduplikowane id w ${etykieta}: "${id}"`);
    }
    widziane.add(id);
    lista.push({ id, nazwa, warianty: warianty || [] });
  }
  return lista;
}

const IMIONA = zbudujListe(IMIONA_RAW, 'IMIONA');
const OWOCE = zbudujListe(OWOCE_RAW, 'OWOCE');

/**
 * Indeks kategorii {kategoria, id, nazwa, slowa} zbudowany z listy {id,
 * nazwa, warianty} - kazdy wariant (w tym sama nazwa) staje sie osobnym
 * wpisem indeksu, rozbitym na slowa przez tokenizujOdpowiedz (import z
 * countries.js - dziala na dowolnym tekscie, nie tylko na nazwach krajow).
 * Wzorem INDEKS_WARIANTOW w countries.js.
 */
function zbudujIndeksKategorii(kategoria, lista) {
  return lista.flatMap(({ id, nazwa, warianty }) =>
    [nazwa, ...warianty]
      .map((wariant) => ({ kategoria, id, nazwa, slowa: tokenizujOdpowiedz(wariant) }))
      .filter((wpis) => wpis.slowa.length > 0),
  );
}

const INDEKS_PANSTWO = INDEKS_WARIANTOW.map(({ kod, slowa }) => ({
  kategoria: 'panstwo',
  id: kod,
  nazwa: COUNTRIES[kod],
  slowa,
}));
const INDEKS_IMIE = zbudujIndeksKategorii('imie', IMIONA);
const INDEKS_OWOC = zbudujIndeksKategorii('owoc', OWOCE);

const INDEKSY_PO_KATEGORII = {
  panstwo: INDEKS_PANSTWO,
  imie: INDEKS_IMIE,
  owoc: INDEKS_OWOC,
};

/**
 * Sprawdza, czy `tokeny` zawieraja `wzorzec` jako CIAGLA sekwencje pelnych
 * slow. Kopia zawieraSekwencje z src/flagbattle.js (ta sama technika
 * dopasowania calymi slowami - patrz komentarz tam) - nie eksportowana stad,
 * wiec kopiujemy zamiast importowac z pliku innej minigry.
 */
function zawieraSekwencje(tokeny, wzorzec) {
  if (wzorzec.length === 0 || wzorzec.length > tokeny.length) return false;
  szukanie: for (let i = 0; i + wzorzec.length <= tokeny.length; i++) {
    for (let j = 0; j < wzorzec.length; j++) {
      if (tokeny[i + j] !== wzorzec[j]) continue szukanie;
    }
    return true;
  }
  return false;
}

/**
 * Znajduje NAJDLUZSZE jednoznaczne dopasowanie w danej kategorii (wzorem
 * najlepszyKodDlaOdpowiedzi we flagbattle.js) - przy remisie miedzy dwoma
 * ROZNYMI id zwraca null (brak jednoznacznego trafienia), zeby np. "sudan"
 * nie zaliczylo sie przypadkiem zamiast dluzszego "sudan poludniowy".
 */
function najlepszeDopasowanieWKategorii(tokeny, indeks) {
  let najlepszaDlugosc = 0;
  let kandydaci = null;
  for (const wpis of indeks) {
    if (wpis.slowa.length < najlepszaDlugosc) continue;
    if (!zawieraSekwencje(tokeny, wpis.slowa)) continue;
    if (wpis.slowa.length > najlepszaDlugosc) {
      najlepszaDlugosc = wpis.slowa.length;
      kandydaci = new Map([[wpis.id, wpis]]);
    } else if (!kandydaci.has(wpis.id)) {
      kandydaci.set(wpis.id, wpis);
    }
  }
  if (!kandydaci || kandydaci.size !== 1) return null;
  return [...kandydaci.values()][0];
}

/**
 * Dopasowuje wiadomosc z czatu do wszystkich trzech kategorii niezaleznie i
 * zwraca WSZYSTKIE trafienia, ktorych KANONICZNA nazwa (nie uzyty wariant)
 * zaczyna sie na `litera`. Gra sama decyduje, ktora kategorie (i czy w
 * ogole) tym trafieniem zapelnic - tu nie ma logiki "kto juz uzyl".
 */
export function dopasujOdpowiedzi(litera, tekstZCzatu) {
  const tokeny = tokenizujOdpowiedz(tekstZCzatu);
  const literaZnormalizowana = normalizeCountryName(litera);
  const wyniki = [];
  for (const kategoria of ['panstwo', 'imie', 'owoc']) {
    const trafienie = najlepszeDopasowanieWKategorii(tokeny, INDEKSY_PO_KATEGORII[kategoria]);
    if (!trafienie) continue;
    if (normalizeCountryName(trafienie.nazwa)[0] !== literaZnormalizowana) continue;
    wyniki.push({ kategoria: trafienie.kategoria, id: trafienie.id, nazwa: trafienie.nazwa });
  }
  return wyniki;
}

/** Zlicza, ile ROZNYCH id (nie wariantow) ma kanoniczna nazwe zaczynajaca sie na kazda litere. */
function policzPoLiterze(lista) {
  const mapa = new Map();
  for (const { nazwa } of lista) {
    const litera = normalizeCountryName(nazwa)[0];
    if (!litera) continue;
    mapa.set(litera, (mapa.get(litera) || 0) + 1);
  }
  return mapa;
}

const LICZBA_PANSTW_PO_LITERZE = policzPoLiterze(COUNTRY_CODES.map((kod) => ({ nazwa: COUNTRIES[kod] })));
const LICZBA_IMION_PO_LITERZE = policzPoLiterze(IMIONA);
const LICZBA_OWOCOW_PO_LITERZE = policzPoLiterze(OWOCE);

/**
 * Litery, z ktorych WOLNO losowac w rundzie. ANTY-SOFTLOCK: litera wchodzi
 * do puli TYLKO gdy KAZDA z trzech kategorii ma dla niej co najmniej 2 rozne
 * id - inaczej drugi gracz w rundzie moglby nie miec czym odpowiedziec, bo
 * pierwszy zajal jedyna mozliwa odpowiedz. Wyliczane z danych, NIE wpisane
 * recznie, zeby zmiana list IMIONA/OWOCE nigdy nie rozjechala sie z ta gwarancja.
 */
export const LITERY_DOZWOLONE = 'abcdefghijklmnopqrstuvwxyz'
  .split('')
  .filter(
    (litera) =>
      (LICZBA_PANSTW_PO_LITERZE.get(litera) || 0) >= 2 &&
      (LICZBA_IMION_PO_LITERZE.get(litera) || 0) >= 2 &&
      (LICZBA_OWOCOW_PO_LITERZE.get(litera) || 0) >= 2,
  );

if (LITERY_DOZWOLONE.length < 10) {
  throw new Error(
    `[panstwa-miasta-dane] Za malo dozwolonych liter w puli: ${LITERY_DOZWOLONE.length} (min. 10) - uzupelnij IMIONA/OWOCE.`,
  );
}
