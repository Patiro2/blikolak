// Samosprawdzenie deterministycznego RNG (src/rng.js).
//
//     node test-rng.mjs
//
// Po co akurat to, skoro reszta gry testow nie ma: determinizm tego modulu
// jest ZALOZENIEM, na ktorym stoi cala synchronizacja miedzy kartami. Kazda
// otwarta karta gry (wlasciciela i kazdego widza) ma wlasne polaczenie z
// czatem Kicka i prowadzi wlasna symulacje - rownania bossa, pola atakow,
// krytyki, Vanessa i zlota moneta zgadzaja sie miedzy kartami WYLACZNIE
// dlatego, ze ten plik przy tym samym kluczu daje ten sam wynik. Gdyby ktos
// kiedys "poprawil" hashString albo mulberry32, gra rozjechalaby sie cicho:
// bez bledu w konsoli, tylko widzowie zaczeliby widziec inne liczby niz
// streamer. Ten plik lapie to od razu.

import assert from 'node:assert/strict';
import { mulberry32, hashString, strumien, tasuj, losujInt, pozycjaBezPowtorek } from './src/rng.js';

let zdane = 0;
function sprawdz(nazwa, fn) {
  fn();
  zdane += 1;
  console.log(`  ok  ${nazwa}`);
}

console.log('test-rng.mjs');

sprawdz('hashString jest stabilny dla tego samego tekstu', () => {
  assert.equal(hashString('123:rownanie:7'), hashString('123:rownanie:7'));
  assert.notEqual(hashString('123:rownanie:7'), hashString('123:rownanie:8'));
});

sprawdz('hashString zawsze daje 32-bitowa liczbe bez znaku', () => {
  for (const tekst of ['', 'a', 'zażółć gęślą jaźń', '0'.repeat(500)]) {
    const h = hashString(tekst);
    assert.ok(Number.isInteger(h), `nie-calkowity hash dla ${JSON.stringify(tekst)}`);
    assert.ok(h >= 0 && h <= 0xffffffff, `hash poza zakresem: ${h}`);
  }
});

sprawdz('mulberry32 z tym samym ziarnem daje ten sam ciag', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

sprawdz('mulberry32 zawsze zwraca liczby z [0, 1)', () => {
  const rng = mulberry32(0xdeadbeef);
  for (let i = 0; i < 10000; i++) {
    const x = rng();
    assert.ok(x >= 0 && x < 1, `poza zakresem: ${x}`);
  }
});

// To jest wlasciwy test synchronizacji: dwie "karty" gry, ten sam seed gry i
// ten sam klucz zdarzenia - muszą policzyc dokladnie to samo.
sprawdz('strumien: dwie karty z tym samym kluczem licza to samo', () => {
  const seedGry = 987654321;
  const msgId = 'abc-123';
  const karta1 = strumien(`${seedGry}:kryt:${msgId}`);
  const karta2 = strumien(`${seedGry}:kryt:${msgId}`);
  for (let i = 0; i < 50; i++) assert.equal(karta1(), karta2());
});

sprawdz('strumien: inny klucz daje inny wynik', () => {
  const a = strumien('1:kryt:aaa')();
  const b = strumien('1:kryt:bbb')();
  assert.notEqual(a, b);
});

sprawdz('losujInt trzyma sie domknietego przedzialu [min, max]', () => {
  const rng = strumien('test:int');
  const trafione = new Set();
  for (let i = 0; i < 5000; i++) {
    const v = losujInt(rng, 3, 7);
    assert.ok(v >= 3 && v <= 7, `poza zakresem: ${v}`);
    trafione.add(v);
  }
  // Oba konce przedzialu musza byc osiagalne - klasyczny blad off-by-one.
  assert.deepEqual([...trafione].sort(), [3, 4, 5, 6, 7]);
});

sprawdz('tasuj zwraca permutacje i nie rusza wejscia', () => {
  const wejscie = Array.from({ length: 50 }, (_, i) => i);
  const kopia = wejscie.slice();
  const wynik = tasuj(strumien('test:tasuj'), wejscie);
  assert.deepEqual(wejscie, kopia, 'tablica wejsciowa zostala zmodyfikowana');
  assert.equal(wynik.length, wejscie.length);
  assert.deepEqual(wynik.slice().sort((a, b) => a - b), kopia);
});

sprawdz('tasuj jest deterministyczne dla tego samego klucza', () => {
  const pula = Array.from({ length: 30 }, (_, i) => `poz-${i}`);
  assert.deepEqual(tasuj(strumien('s:x'), pula), tasuj(strumien('s:x'), pula));
});

// Najwazniejsza wlasnosc pozycjaBezPowtorek: w obrebie jednego cyklu (czyli
// dopoki nie wyczerpiemy calej puli) ZADNA pozycja nie moze sie powtorzyc.
// To jest cala racja bytu tej funkcji - stary kod "losuj az trafisz nowe"
// po wyczerpaniu prob oddawal powtorke.
sprawdz('pozycjaBezPowtorek nie powtarza w obrebie jednego cyklu', () => {
  const pula = Array.from({ length: 40 }, (_, i) => `flaga-${i}`);
  const widziane = new Set();
  for (let licznik = 0; licznik < pula.length; licznik++) {
    const poz = pozycjaBezPowtorek(555, 'flagi', pula, licznik);
    assert.ok(!widziane.has(poz), `powtorka "${poz}" przy liczniku ${licznik}`);
    widziane.add(poz);
  }
  assert.equal(widziane.size, pula.length, 'nie wyczerpano calej puli');
});

sprawdz('pozycjaBezPowtorek zaczyna nowy cykl po wyczerpaniu puli', () => {
  const pula = Array.from({ length: 10 }, (_, i) => i);
  const cykl1 = Array.from({ length: 10 }, (_, i) => pozycjaBezPowtorek(7, 'p', pula, i));
  const cykl2 = Array.from({ length: 10 }, (_, i) => pozycjaBezPowtorek(7, 'p', pula, 10 + i));
  assert.deepEqual(cykl1.slice().sort((a, b) => a - b), pula);
  assert.deepEqual(cykl2.slice().sort((a, b) => a - b), pula);
  assert.notDeepEqual(cykl1, cykl2, 'drugi cykl ma te sama kolejnosc co pierwszy');
});

sprawdz('pozycjaBezPowtorek: dwie karty z tym samym seedem widza to samo', () => {
  const pula = Array.from({ length: 25 }, (_, i) => `slowo-${i}`);
  for (let licznik = 0; licznik < 60; licznik++) {
    assert.equal(
      pozycjaBezPowtorek(31337, 'slowka', pula, licznik),
      pozycjaBezPowtorek(31337, 'slowka', pula, licznik),
    );
  }
});

console.log(`\n${zdane} sprawdzen zdanych.`);
