// Sprezystosc.js - proceduralny "squash & stretch" przy chodzeniu oraz
// delikatne kolysanie w bezczynnosci dla modeli pracownikow.
//
// BEZPIECZENSTWO WZGLEDEM workers.js (plik nietykalny): caly efekt idzie
// na entry.model - dziecko entry.obj dodane w _applyVisual (workers.js
// linia 225: entry.obj.add(model)). workers.js NIGDY nie czyta ani nie
// nadpisuje pozycji/rotacji/skali entry.model - wszystkie operacje ruchu,
// obrotu i synchronizacji (linie 665-667, 784-798, 883-904 w workers.js)
// dzialaja WYLACZNIE na entry.obj.position/rotation. Jedyny dotyk modelu
// to model.scale.setScalar(spec.scale) raz, przy tworzeniu (linia 216) -
// dlatego bazowa skala jest tu zapamietywana PRZY PIERWSZYM SPOTKANIU i
// efekt jest nakladany WZGLEDEM niej (mnozeniem), nigdy jej nie nadpisujac.
// Brak posredniego Group-wrappera: entry.model juz jest tym dzieckiem,
// wiec nie ma potrzeby wstawiania kolejnej warstwy w hierarchii.

const wylaczone = (() => {
  try {
    return new URLSearchParams(location.search).get('sprezystosc') === '0';
  } catch {
    return false;
  }
})();

// stan per-postac (klucz: entry.obj - Group tworzony raz na typeIndex,
// patrz workers.js linia 387). Brak alokacji na klatke poza pierwszym
// spotkaniem postaci.
const stany = new Map();

const PROG_PREDKOSCI = 0.4; // j/s - powyzej tego uznajemy postac za idaca
const TAU_MIESZANIA = 0.15; // sprezyste tlumienie przejscia idle <-> chod
const AMPLITUDA_PODSKOKU = 0.03;
const AMPLITUDA_SQUASH = 0.06;
const OKRES_KOLYSANIA = 2.5; // sekundy
const AMPLITUDA_KOLYSANIA = 0.02; // ~2% przechyl/oddech

function nowyStan(model, staraFaza) {
  return {
    model, // do wykrycia podmiany skina - patrz uzycie w petli glownej
    ostPozycja: null, // ustawiane ponizej z obj.position (Vector3 juz istnieje, tylko klonujemy)
    faza: staraFaza !== undefined ? staraFaza : Math.random() * Math.PI * 2, // losowa faza bezczynnosci - postacie nie kolysza sie synchronicznie
    walkPhase: 0,
    mix: 0, // 0 = idle, 1 = chod, tlumione sprezynowo
    bazowaSkalaX: model.scale.x,
    bazowaSkalaY: model.scale.y,
    bazowaSkalaZ: model.scale.z,
    // Pozycja Y i przechyl Z modelu to zawsze 0 (swiezy SkeletonUtils.clone,
    // workers.js ustawia tylko skale), ale jetpack.js:270-271 nadpisuje je w
    // locie. Zapamietanie ich przy pierwszym spotkaniu postaci W TRAKCIE lotu
    // trzymaloby ja po wyladowaniu 1.2 j. nad ziemia - stad stale zero.
    bazowaPozY: 0,
    bazowaRotZ: 0,
  };
}

/**
 * Wywolywac raz na klatke, PO workerManager.update(delta) - patrz main.js.
 * Bezpieczne do wywolania nawet gdy workerManager.entries jest puste.
 */
export function updateSprezystosc(workerManager, delta) {
  if (wylaczone || !workerManager || !workerManager.entries) return;

  const zywe = new Set();

  for (const entry of workerManager.entries) {
    if (!entry.obj || !entry.model) continue;
    zywe.add(entry.obj);

    let stan = stany.get(entry.obj);
    if (!stan || stan.model !== entry.model) {
      // Brak wpisu albo podmiana modelu (zmiana skina w _applyVisual,
      // workers.js linia 224-226) - nowy model ma inna baze skali/pozycji.
      stan = nowyStan(entry.model, stan ? stan.faza : undefined);
      stan.ostPozycja = entry.obj.position.clone();
      stany.set(entry.obj, stan);
    }

    // Predkosc z roznicy pozycji swiata obiektu miedzy klatkami (tylko X/Z -
    // Y to juz wlasny podskok kroku z workers.js, nie chcemy go liczyc jako "ruch").
    const dx = entry.obj.position.x - stan.ostPozycja.x;
    const dz = entry.obj.position.z - stan.ostPozycja.z;
    stan.ostPozycja.copy(entry.obj.position);
    const predkosc = delta > 0 ? Math.sqrt(dx * dx + dz * dz) / delta : 0;

    // Tlumienie sprezynowe miedzy stanem idle a chodem (plynne, niezalezne od fps)
    const cel = predkosc > PROG_PREDKOSCI ? 1 : 0;
    const wspolczynnik = 1 - Math.exp(-delta / TAU_MIESZANIA);
    stan.mix += (cel - stan.mix) * wspolczynnik;

    // Faza kroku rosnie proporcjonalnie do przebytej drogi - naturalnie
    // przyspiesza/zwalnia z predkoscia zamiast byc stalym tempem.
    stan.walkPhase += predkosc * delta * 3.2;

    const model = entry.model;

    if (stan.mix > 0.001) {
      // Podskok w rytm kroku (wartosc bezwzgledna sinusa = dwa "uderzenia" na cykl,
      // jak lewa/prawa noga) + squash/stretch: rozciagniecie w gorze skoku,
      // splaszczenie przy "ladowaniu".
      // |sin| = 1 w szczycie, 0 przy ladowaniu; (2h - 1) zamiast sin, bo sin = -1
      // tez wypada w szczycie i splaszczalby postac w powietrzu co drugi krok.
      const h = Math.abs(Math.sin(stan.walkPhase));
      const podskok = h * AMPLITUDA_PODSKOKU * stan.mix;
      const rozciagniecie = (2 * h - 1) * AMPLITUDA_SQUASH * stan.mix;

      model.position.y = stan.bazowaPozY + podskok;
      model.scale.y = stan.bazowaSkalaY * (1 + rozciagniecie);
      model.scale.x = stan.bazowaSkalaX * (1 - rozciagniecie * 0.5);
      model.scale.z = stan.bazowaSkalaZ * (1 - rozciagniecie * 0.5);
    }

    if (stan.mix < 0.999) {
      // Powolne kolysanie bezczynnosci: przechyl + "oddech" skali, faza
      // rozna dla kazdej postaci (stan.faza).
      const idleMix = 1 - stan.mix;
      const t = (performance.now() / 1000) * (2 * Math.PI / OKRES_KOLYSANIA) + stan.faza;
      const przechyl = Math.sin(t) * AMPLITUDA_KOLYSANIA * idleMix;
      const oddech = 1 + Math.cos(t) * AMPLITUDA_KOLYSANIA * 0.5 * idleMix;

      model.rotation.z = stan.bazowaRotZ + przechyl;
      // Skala idle nadpisuje ta sama wlasnosc co chod - przy mix bliskim 0
      // efekt chodu jest juz pomijalny (blok wyzej), wiec nie ma konfliktu.
      if (stan.mix <= 0.001) {
        model.scale.y = stan.bazowaSkalaY * oddech;
        model.scale.x = stan.bazowaSkalaX;
        model.scale.z = stan.bazowaSkalaZ;
      }
    } else {
      model.rotation.z = stan.bazowaRotZ;
    }
  }

  // Sprzatanie wpisow dla usunietych/podmienionych postaci (removeWorkerType,
  // podmiana skina tworzaca nowy model - patrz workers.js _applyVisual).
  if (stany.size > zywe.size) {
    for (const klucz of stany.keys()) {
      if (!zywe.has(klucz)) stany.delete(klucz);
    }
  }
}
