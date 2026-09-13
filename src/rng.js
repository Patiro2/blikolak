// Deterministyczny generator liczb losowych dzielony przez WSZYSTKIE otwarte
// karty gry. Kazda karta prowadzi wlasna, niezalezna symulacje (patrz
// src/kick.js - kazda karta sama laczy sie z czatem Kicka), wiec golego
// Math.random() nie da sie uzywac w logice rozgrywki - kazda karta wylosowalaby
// cos innego. Rozwiazanie: wspolne ziarno gry (economy.state.seedGry, patrz
// src/economy.js) plus klucz opisujacy KONKRETNE zdarzenie (numer wiadomosci
// czatu, numer rownania w walce, numer cyklu czasowego...) - kazda karta,
// widzac ten sam klucz, wylicza DOKLADNIE ten sam wynik.
//
// Zero stanu globalnego - kazda funkcja dostaje wszystko, czego potrzebuje,
// jawnie w argumentach.

/**
 * Szybki, deterministyczny PRNG (Mulberry32). `seed` to liczba 32-bitowa.
 * Zwraca funkcje bezargumentowa, ktora przy kazdym wywolaniu daje kolejna
 * liczbe zmiennoprzecinkowa z przedzialu [0, 1) - jak Math.random(), tylko
 * powtarzalnie dla tego samego ziarna.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stabilny hash 32-bit dowolnego tekstu (wariant xmur3). Zamienia dowolny
 * klucz stringowy (np. "12345:rownanie:1:7") na liczbe, ktora mozna podac
 * jako ziarno do mulberry32. Ten sam tekst zawsze daje ten sam hash - na
 * kazdej karcie, w kazdej przegladarce.
 */
export function hashString(tekst) {
  const s = String(tekst);
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Zwraca PRNG zasiany hashem podanego klucza - gotowy, deterministyczny
 * strumien losowosci dla jednego konkretnego zdarzenia rozgrywki. Konwencja
 * klucza uzywana w calej grze: `${seedGry}:${nazwaZdarzenia}:${licznik}`.
 */
export function strumien(klucz) {
  return mulberry32(hashString(klucz));
}

/** Losowa liczba calkowita z przedzialu [min, max] (obustronnie domkniety). */
export function losujInt(rng, min, max) {
  return Math.floor(min + rng() * (max - min + 1));
}

/** Losowy element tablicy. */
export function losujZ(rng, tablica) {
  return tablica[Math.floor(rng() * tablica.length)];
}

/**
 * Deterministyczna permutacja tablicy (tasowanie Fishera-Yatesa napedzane
 * podanym strumieniem). Zwraca NOWA tablice - wejsciowa zostaje nietknieta.
 *
 * Po co, skoro mielismy juz losujZ w petli "losuj az trafisz cos nowego"?
 * Tamten wzorzec mial trzy wady, ktore ta funkcja kasuje naraz:
 *  - przy dluzszej bitwie coraz wiecej prob trafialo w juz uzyte pozycje, a
 *    po wyczerpaniu limitu prob kod ODDAWAL POWTORKE (fallback losujZ),
 *  - odrzucanie kandydatow lekko zaburzalo rozklad w kolejnych rundach,
 *  - liczba wywolan rng() zalezala od historii bitwy, wiec przebieg trudniej
 *    bylo odtworzyc z samego klucza.
 * Permutacja daje: zero powtorek w obrebie jednej bitwy Z DEFINICJI, dokladnie
 * jednostajne 1/N na kazda pozycje puli i stala, przewidywalna liczbe
 * wywolan rng(). Determinizm (a wiec i synchronizacja miedzy kartami, patrz
 * komentarz na gorze pliku) zostaje bez zmian - wynik zalezy wylacznie od
 * strumienia.
 */
export function tasuj(rng, tablica) {
  const wynik = tablica.slice();
  for (let i = wynik.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = wynik[i];
    wynik[i] = wynik[j];
    wynik[j] = tmp;
  }
  return wynik;
}

// Cache ostatniej permutacji per (nazwaPuli:cykl) - zeby pozycjaBezPowtorek
// nie tasowal calej puli (np. 1000 slowek) przy kazdej pojedynczej rundzie.
const _cacheCykli = new Map();

/**
 * Zwraca kolejna pozycje z puli BEZ POWTOREK w obrebie calej rozgrywki: jedna
 * permutacja calej puli na "cykl" (floor(licznik/pula.length)), dopiero po
 * wyczerpaniu wszystkich pozycji zaczyna sie nowy cykl z nowa permutacja.
 * `licznik` to trwaly, zapisywany licznik (np. economy.state.licznikFlag) -
 * rosnie monotonicznie przez cala rozgrywke, wiec dziala tez po przeladowaniu
 * strony.
 */
export function pozycjaBezPowtorek(seedGry, nazwaPuli, pula, licznik) {
  const cykl = Math.floor(licznik / pula.length);
  const kluczCache = `${seedGry}:${nazwaPuli}:${cykl}`;
  let perm = _cacheCykli.get(kluczCache);
  if (!perm) {
    perm = tasuj(strumien(`${seedGry}:${nazwaPuli}:cykl:${cykl}`), pula);
    _cacheCykli.set(kluczCache, perm);
  }
  return perm[licznik % pula.length];
}
