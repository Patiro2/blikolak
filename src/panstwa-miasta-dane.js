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
// Ok. 350 polskich imion (meskich i zenskich) - od najpopularniejszych,
// jakie polski czat streamu realnie zna, po mniej popularne i staropolskie
// (Mieszko, Bolesław, Jadwiga, Wiesław, Zdzisław). Kazdy wpis: [id, nazwa,
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
  ['aldona', 'Aldona'],
  ['albert', 'Albert'],
  ['andrzej', 'Andrzej', ['jedrek']],
  ['aniela', 'Aniela'],
  ['anastazja', 'Anastazja'],
  ['apolonia', 'Apolonia'],
  ['arkadiusz', 'Arkadiusz', ['arek']],
  ['augustyn', 'Augustyn'],
  ['amadeusz', 'Amadeusz'],
  ['alan', 'Alan'],
  ['arnold', 'Arnold'],
  ['aurelia', 'Aurelia'],
  ['apolinary', 'Apolinary'],
  ['anzelm', 'Anzelm'],
  ['augustyna', 'Augustyna'],
  ['anatol', 'Anatol'],
  ['amanda', 'Amanda'],
  // --- B ---
  ['barbara', 'Barbara', ['basia']],
  ['bartosz', 'Bartosz', ['bartek']],
  ['beata', 'Beata'],
  ['bogdan', 'Bogdan'],
  ['bozena', 'Bożena'],
  ['brygida', 'Brygida'],
  ['bogumila', 'Bogumiła'],
  ['boleslaw', 'Bolesław', ['bolek']],
  ['benedykt', 'Benedykt'],
  ['blazej', 'Błażej'],
  ['bernadeta', 'Bernadeta'],
  ['bronislaw', 'Bronisław', ['bronek']],
  ['boguslaw', 'Bogusław', ['bogus']],
  ['bartlomiej', 'Bartłomiej', ['bartus']],
  ['borys', 'Borys'],
  ['bibianna', 'Bibianna'],
  ['bozydar', 'Bożydar'],
  ['blazeja', 'Błażeja'],
  ['bogumil', 'Bogumił'],
  ['bronislawa', 'Bronisława'],
  ['benedykta', 'Benedykta'],
  // --- C ---
  ['cecylia', 'Cecylia'],
  ['cezary', 'Cezary', ['czarek']],
  ['celina', 'Celina'],
  ['czeslaw', 'Czesław', ['czesiek']],
  ['cyprian', 'Cyprian'],
  ['cyryl', 'Cyryl'],
  ['celestyna', 'Celestyna'],
  ['cezaryna', 'Cezaryna'],
  ['celestyn', 'Celestyn'],
  // --- D ---
  ['damian', 'Damian'],
  ['daniel', 'Daniel', ['danek']],
  ['danuta', 'Danuta'],
  ['dariusz', 'Dariusz', ['darek']],
  ['dominik', 'Dominik'],
  ['dominika', 'Dominika'],
  ['dorota', 'Dorota'],
  ['dawid', 'Dawid'],
  ['donat', 'Donat'],
  ['dobromila', 'Dobromiła'],
  ['dobroslawa', 'Dobrosława'],
  ['dorian', 'Dorian'],
  ['dionizy', 'Dionizy'],
  ['dagmara', 'Dagmara'],
  ['delfina', 'Delfina'],
  ['dobromir', 'Dobromir'],
  ['dobrawa', 'Dobrawa'],
  ['damiana', 'Damiana'],
  ['donata', 'Donata'],
  ['dionizja', 'Dionizja'],
  // --- E ---
  ['edward', 'Edward', ['edek']],
  ['elzbieta', 'Elżbieta', ['ela', 'elka']],
  ['emilia', 'Emilia'],
  ['ewa', 'Ewa'],
  ['ewelina', 'Ewelina'],
  ['eugeniusz', 'Eugeniusz'],
  ['emil', 'Emil'],
  ['eryk', 'Eryk'],
  ['edyta', 'Edyta'],
  ['eliza', 'Eliza'],
  ['eugenia', 'Eugenia'],
  ['elwira', 'Elwira'],
  ['euzebiusz', 'Euzebiusz'],
  ['estera', 'Estera'],
  ['emilian', 'Emilian'],
  ['eustachy', 'Eustachy'],
  // --- F ---
  ['filip', 'Filip'],
  ['franciszek', 'Franciszek', ['franek']],
  ['feliks', 'Feliks'],
  ['florentyna', 'Florentyna'],
  ['fabian', 'Fabian'],
  ['florian', 'Florian'],
  ['fryderyk', 'Fryderyk'],
  ['fortunat', 'Fortunat'],
  ['faustyna', 'Faustyna'],
  // --- G ---
  ['gabriela', 'Gabriela', ['gabrysia']],
  ['grazyna', 'Grażyna'],
  ['grzegorz', 'Grzegorz', ['grzesiek']],
  ['gustaw', 'Gustaw'],
  ['gabriel', 'Gabriel'],
  ['genowefa', 'Genowefa'],
  ['gertruda', 'Gertruda'],
  ['gerard', 'Gerard'],
  ['gracjan', 'Gracjan'],
  ['gawel', 'Gaweł'],
  ['gerwazy', 'Gerwazy'],
  ['gaudenty', 'Gaudenty'],
  ['gniewomir', 'Gniewomir'],
  ['gniewko', 'Gniewko'],
  // --- H ---
  ['halina', 'Halina'],
  ['hanna', 'Hanna', ['hania']],
  ['henryk', 'Henryk', ['henio']],
  ['hubert', 'Hubert'],
  ['helena', 'Helena'],
  ['hilary', 'Hilary'],
  ['hieronim', 'Hieronim'],
  ['honorata', 'Honorata'],
  ['hipolit', 'Hipolit'],
  ['hortensja', 'Hortensja'],
  ['hermina', 'Hermina'],
  // --- I ---
  ['ignacy', 'Ignacy'],
  ['irena', 'Irena'],
  ['iwona', 'Iwona'],
  ['izabela', 'Izabela', ['iza']],
  ['ida', 'Ida'],
  ['ireneusz', 'Ireneusz'],
  ['inga', 'Inga'],
  ['iwo', 'Iwo'],
  ['izydor', 'Izydor'],
  ['ilona', 'Ilona'],
  ['izolda', 'Izolda'],
  // --- J ---
  ['jacek', 'Jacek'],
  ['jadwiga', 'Jadwiga', ['jadzia']],
  ['jakub', 'Jakub', ['kuba', 'kubus']],
  ['jan', 'Jan', ['janek', 'jasiek', 'jas']],
  ['janina', 'Janina'],
  ['janusz', 'Janusz'],
  ['jerzy', 'Jerzy', ['jurek']],
  ['joanna', 'Joanna', ['asia']],
  ['jolanta', 'Jolanta', ['jola']],
  ['jozef', 'Józef', ['jozek', 'jozio']],
  ['julia', 'Julia'],
  ['julian', 'Julian'],
  ['justyna', 'Justyna'],
  ['jaroslaw', 'Jarosław', ['jarek']],
  ['julianna', 'Julianna'],
  ['judyta', 'Judyta'],
  ['jedrzej', 'Jędrzej', ['jedrus']],
  ['jonasz', 'Jonasz'],
  ['joachim', 'Joachim'],
  ['jaroslawa', 'Jarosława'],
  ['jagoda', 'Jagoda'],
  ['justyn', 'Justyn'],
  ['jonatan', 'Jonatan'],
  ['jozefina', 'Józefina'],
  ['jaromir', 'Jaromir'],
  // --- K ---
  ['kacper', 'Kacper'],
  ['karol', 'Karol'],
  ['karolina', 'Karolina'],
  ['katarzyna', 'Katarzyna', ['kasia', 'kaska']],
  ['kazimierz', 'Kazimierz', ['kazik']],
  ['kinga', 'Kinga'],
  ['konrad', 'Konrad'],
  ['krystian', 'Krystian'],
  ['krystyna', 'Krystyna', ['krysia']],
  ['krzysztof', 'Krzysztof', ['krzysiek', 'krzys']],
  ['klaudia', 'Klaudia'],
  ['konstancja', 'Konstancja'],
  ['kornelia', 'Kornelia'],
  ['kryspin', 'Kryspin'],
  ['kajetan', 'Kajetan'],
  ['kalina', 'Kalina'],
  ['kordian', 'Kordian'],
  ['kunegunda', 'Kunegunda'],
  ['klara', 'Klara'],
  ['kamil', 'Kamil'],
  ['kamila', 'Kamila'],
  ['ksawery', 'Ksawery'],
  ['ksenia', 'Ksenia'],
  ['konstanty', 'Konstanty'],
  ['klemens', 'Klemens'],
  ['kryspina', 'Kryspina'],
  ['kazimiera', 'Kazimiera'],
  // --- L (Ł normalizuje sie do L - patrz normalizeCountryName) ---
  ['leon', 'Leon'],
  ['leszek', 'Leszek'],
  ['liliana', 'Liliana'],
  ['lucyna', 'Lucyna'],
  ['ludwik', 'Ludwik'],
  ['lidia', 'Lidia'],
  ['lukasz', 'Łukasz', ['lukaszek']],
  ['leonard', 'Leonard'],
  ['laura', 'Laura'],
  ['lech', 'Lech'],
  ['lechoslaw', 'Lechosław'],
  ['lucjan', 'Lucjan'],
  ['longina', 'Longina'],
  ['lena', 'Lena'],
  ['liwia', 'Liwia'],
  ['leokadia', 'Leokadia'],
  // --- M ---
  ['maciej', 'Maciej', ['maciek']],
  ['magdalena', 'Magdalena', ['magda', 'madzia']],
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
  ['mateusz', 'Mateusz', ['mati']],
  ['michal', 'Michał', ['michalek', 'misiek']],
  ['michalina', 'Michalina'],
  ['mieczyslaw', 'Mieczysław', ['mietek']],
  ['mikolaj', 'Mikołaj', ['mikus']],
  ['milena', 'Milena'],
  ['miroslaw', 'Mirosław', ['mirek']],
  ['monika', 'Monika'],
  ['malgorzata', 'Małgorzata', ['gosia', 'malgosia', 'goska']],
  ['maksymilian', 'Maksymilian', ['maks']],
  ['mieszko', 'Mieszko'],
  ['matylda', 'Matylda'],
  ['milosz', 'Miłosz'],
  ['mira', 'Mira'],
  ['marcelina', 'Marcelina'],
  ['miron', 'Miron'],
  ['melchior', 'Melchior'],
  ['marcjanna', 'Marcjanna'],
  ['miloslawa', 'Miłosława'],
  ['marcelin', 'Marcelin'],
  // --- N ---
  ['natalia', 'Natalia'],
  ['nikodem', 'Nikodem'],
  ['nikola', 'Nikola'],
  ['norbert', 'Norbert'],
  ['nina', 'Nina'],
  ['nadia', 'Nadia'],
  ['nestor', 'Nestor'],
  ['narcyz', 'Narcyz'],
  ['nikita', 'Nikita'],
  ['natasza', 'Natasza'],
  // --- O ---
  ['oliwia', 'Oliwia'],
  ['oskar', 'Oskar'],
  ['olga', 'Olga'],
  ['otylia', 'Otylia'],
  ['oktawia', 'Oktawia'],
  ['onufry', 'Onufry'],
  ['oswald', 'Oswald'],
  ['olimpia', 'Olimpia'],
  // --- P ---
  ['patryk', 'Patryk'],
  ['paulina', 'Paulina'],
  ['pawel', 'Paweł', ['pawelek']],
  ['piotr', 'Piotr', ['piotrek']],
  ['przemyslaw', 'Przemysław', ['przemek']],
  ['patrycja', 'Patrycja'],
  ['pelagia', 'Pelagia'],
  ['petronela', 'Petronela'],
  ['pankracy', 'Pankracy'],
  ['prosper', 'Prosper'],
  ['platon', 'Platon'],
  ['paula', 'Paula'],
  ['prokop', 'Prokop'],
  ['pius', 'Pius'],
  ['protazy', 'Protazy'],
  // --- R ---
  ['rafal', 'Rafał'],
  ['renata', 'Renata'],
  ['robert', 'Robert'],
  ['roman', 'Roman'],
  ['roksana', 'Roksana'],
  ['ryszard', 'Ryszard', ['rysiek']],
  ['radoslaw', 'Radosław', ['radek']],
  ['rozalia', 'Rozalia'],
  ['remigiusz', 'Remigiusz'],
  ['roland', 'Roland'],
  ['radoslawa', 'Radosława'],
  ['rufin', 'Rufin'],
  ['rut', 'Rut'],
  ['rudolf', 'Rudolf'],
  // --- S ---
  ['sabina', 'Sabina'],
  ['sandra', 'Sandra'],
  ['sebastian', 'Sebastian', ['sebek']],
  ['slawomir', 'Sławomir', ['slawek']],
  ['stanislaw', 'Stanisław', ['staszek', 'stasiu', 'stach']],
  ['stefan', 'Stefan'],
  ['sylwester', 'Sylwester', ['sylwek']],
  ['sylwia', 'Sylwia'],
  ['szymon', 'Szymon'],
  ['stefania', 'Stefania'],
  ['seweryn', 'Seweryn'],
  ['salomea', 'Salomea'],
  ['symeon', 'Symeon'],
  ['sonia', 'Sonia'],
  ['sara', 'Sara'],
  ['stella', 'Stella'],
  ['seweryna', 'Seweryna'],
  ['stanislawa', 'Stanisława'],
  ['sylwan', 'Sylwan'],
  // --- T ---
  ['tadeusz', 'Tadeusz', ['tadek']],
  ['tomasz', 'Tomasz', ['tomek']],
  ['teodor', 'Teodor'],
  ['teresa', 'Teresa'],
  ['tymoteusz', 'Tymoteusz'],
  ['tobiasz', 'Tobiasz'],
  ['tacjana', 'Tacjana'],
  ['tymon', 'Tymon'],
  ['teodozja', 'Teodozja'],
  ['tekla', 'Tekla'],
  ['tyberiusz', 'Tyberiusz'],
  // --- U ---
  ['urszula', 'Urszula', ['ula']],
  ['urban', 'Urban'],
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
  ['wlodzimierz', 'Włodzimierz', ['wlodek']],
  ['wincenty', 'Wincenty'],
  ['walenty', 'Walenty'],
  ['wawrzyniec', 'Wawrzyniec'],
  ['wladyslawa', 'Władysława'],
  ['wieslawa', 'Wiesława'],
  ['wilhelm', 'Wilhelm'],
  // --- Z (Ż normalizuje sie do Z) ---
  ['zbigniew', 'Zbigniew', ['zbyszek']],
  ['zdzislaw', 'Zdzisław', ['zdzisiek']],
  ['zenon', 'Zenon'],
  ['zofia', 'Zofia', ['zosia']],
  ['zuzanna', 'Zuzanna', ['zuzia']],
  ['zygmunt', 'Zygmunt'],
  ['zaneta', 'Żaneta'],
  ['zdzislawa', 'Zdzisława'],
  ['zenobia', 'Zenobia'],
  ['ziemowit', 'Ziemowit'],
  ['zyta', 'Zyta'],
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
