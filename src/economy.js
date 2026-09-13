// Ekonomia gry dla widzow streama - CALA progresja dzieje sie sama w reakcji
// na aktywnosc czatu Kick.com. Gracz (streamer) nic nie kupuje - klika tylko
// czasem sam, a widzowie napedzaja postep pisac "klik" na czacie.

import { strumien } from './rng.js';

export const SAVE_KEY = 'bankomat-clicker-v3';
const OLD_SAVE_KEY = 'bankomat-clicker-v2'; // stary zapis z systemem kupowania - migrujemy tylko tier automatu

export const MACHINE_TIERS = [
  { key: 'gambling-machine', name: 'Automat hazardowy', mult: 1 },
  { key: 'vending-machine', name: 'Automat vendingowy', mult: 1 },
  { key: 'ticket-machine', name: 'Automat biletowy', mult: 1 },
  { key: 'arcade-machine', name: 'Automat arcade', mult: 1 },
  { key: 'claw-machine', name: 'Automat ze szczypcami', mult: 1 },
  { key: 'dance-machine', name: 'Automat taneczny', mult: 1 },
];

// Progi LACZNEJ liczby klikniec z czatu potrzebne do awansu na dany tier
// automatu (indeks = tier, tier 0 jest odblokowany od razu). Awans jest
// automatyczny - gdy suma klikniec z czatu przekroczy prog, bankomat sam
// podmienia model i pokazuje baner na gorze ekranu (patrz main.js).
export const MACHINE_TIER_CLICK_THRESHOLDS = [0, 500, 1000, 2000, 4000, 8000];

// 10 stalych "rol" pracownikow - kazda przypisana do jednego miejsca w Top 10
// rankingu widzow (patrz kick.js updateAssignments). Nikt ich nie kupuje -
// awatar po prostu pojawia sie w scenie, gdy ktos wejdzie do Top 10.
export const WORKER_TYPE_DEFS = [
  { name: 'Kasjer', modelKey: 'character-employee' },
  { name: 'Stazysta', modelKey: 'character-male-a' },
  { name: 'Stazystka', modelKey: 'character-female-a' },
  { name: 'Sprzedawca', modelKey: 'character-male-b' },
  { name: 'Sprzedawczyni', modelKey: 'character-female-b' },
  { name: 'Kierownik zmiany', modelKey: 'character-male-c' },
  { name: 'Kierowniczka zmiany', modelKey: 'character-female-c' },
  { name: 'Specjalista', modelKey: 'character-male-d' },
  { name: 'Specjalistka', modelKey: 'character-female-d' },
  { name: 'Dyrektor oddzialu', modelKey: 'character-male-e' },
];

// Tempo (klik/s rownowazne) dochodu pasywnego generowanego przez awatar na
// danym MIEJSCU w rankingu (rank 1 = najlepsze, najszybsze; rank 10 =
// najslabsze). Miejsce 1 zarabia najwiecej, miejsce 10 najmniej.

// Krytyczne klikniecia - STALA szansa i STALY mnoznik (nic tu sie nie kupuje).
const CRIT_CHANCE = 0.05; // 5% szans na trafienie krytyczne
const CRIT_MULT = 3; // krytyk mnozy wartosc klikniecia razy 3

// Bonus za kombo szybkiego klikania calego czatu (stan runtime, niezapisywany).
// Kolejne klikniecia (od dowolnych widzow) trafiajace w krotkim oknie czasu
// od siebie podbijaja wspolny mnoznik - nagradza zywy, aktywny czat.
const COMBO_WINDOW_MS = 700;
const COMBO_STEP = 0.04; // +4% za stopien kombo
const COMBO_MAX = 25; // maks. +100%

/** Losuje nowe 32-bitowe ziarno gry - wywolywane raz przy pierwszym starcie i przy kazdym resecie. */
function losujSeedGry() {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

function defaultState() {
  return {
    money: 0, // wspolna pula czatu (nie portfel gracza!)
    totalEarned: 0, // suma wszystkiego, co kiedykolwiek wplynelo do puli
    // Laczna liczba klikniec liczacych sie do awansu tieru: komendy "klik" z
    // czatu ORAZ klikniecia wlasciciela myszka w model. Nazwa pola jest
    // historyczna (kiedys liczyl sie sam czat) - zostaje, bo siedzi w
    // zapisanym stanie w localStorage i w KV, a przemianowanie wymagaloby
    // migracji zapisow bez zadnego zysku.
    totalChatClicks: 0,
    machineTier: 0,
    bossesDefeated: [], // numery tierow, dla ktorych boss zostal juz pokonany (anty-powtorka)
    // Wspolne ziarno calej rozgrywki - wylosowane RAZ (tu albo przy resecie) i
    // zapisywane w stanie, wiec trafia do KV i do localStorage jak reszta pol.
    // Kazda otwarta karta gry losuje NIEZALEZNIE (wlasne polaczenie z czatem,
    // wlasna symulacja - patrz src/kick.js), ale widzac to samo seedGry i ten
    // sam klucz zdarzenia (patrz src/rng.js), wszystkie karty licza DOKLADNIE
    // to samo - rownania bossa, pola atakow, krytyki, Vanesse, zlota moneta.
    seedGry: losujSeedGry(),
    // Trwale liczniki "ile pozycji tej puli juz wydano w tej rozgrywce" -
    // patrz pozycjaBezPowtorek w rng.js. Zapisywane w stanie (jak seedGry),
    // wiec bitwy o flagi/tlumaczen nie powtarzaja zestawow miedzy
    // przeladowaniami strony ani miedzy kolejnymi bitwami tej samej rozgrywki.
    licznikFlag: 0,
    licznikSlowek: 0,
    licznikLiter: 0, // patrz komentarz wyzej - trwaly licznik dla minigry "Panstwa-Miasta"
    licznikMarek: 0, // patrz komentarz wyzej - trwaly licznik dla minigry "Zgadnij marke"
    // Znacznik czasu (ms) ustawiany razem z seedGry - kotwica dla zdarzen
    // czasowych (harmonogram Vanessy, zlotej monety), patrz src/vanessa.js
    // i src/goldcoin.js: numer cyklu = floor((Date.now()-epokaStartu)/dlugoscCyklu).
    epokaStartu: Date.now(),
    lastSave: Date.now(),
  };
}

export class Economy {
  constructor() {
    this.state = this.load() ?? defaultState();

    // Stan kombo - celowo poza this.state, zeby nie trafial do zapisu.
    this._combo = 0;
    this._comboLastClickMs = 0;
  }

  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const d = defaultState();
        const merged = { ...d, ...parsed };

        // Sanity-check kazdego pola - stary/uszkodzony zapis nie moze wywalic gry.
        if (typeof merged.money !== 'number' || !isFinite(merged.money)) merged.money = 0;
        if (typeof merged.totalEarned !== 'number' || !isFinite(merged.totalEarned)) merged.totalEarned = 0;
        if (typeof merged.totalChatClicks !== 'number' || !isFinite(merged.totalChatClicks) || merged.totalChatClicks < 0) {
          merged.totalChatClicks = 0;
        }
        if (typeof merged.machineTier !== 'number' || merged.machineTier < 0 || merged.machineTier >= MACHINE_TIERS.length) {
          merged.machineTier = 0;
        }
        if (!Array.isArray(merged.bossesDefeated)) {
          merged.bossesDefeated = [];
        } else {
          merged.bossesDefeated = merged.bossesDefeated.filter((t) => typeof t === 'number' && t >= 0);
        }
        if (typeof merged.seedGry !== 'number' || !isFinite(merged.seedGry) || merged.seedGry < 0) {
          merged.seedGry = losujSeedGry();
        } else {
          merged.seedGry = merged.seedGry >>> 0;
        }
        if (typeof merged.epokaStartu !== 'number' || !isFinite(merged.epokaStartu) || merged.epokaStartu <= 0) {
          merged.epokaStartu = Date.now();
        }
        if (typeof merged.licznikFlag !== 'number' || !isFinite(merged.licznikFlag) || merged.licznikFlag < 0) {
          merged.licznikFlag = 0;
        }
        if (typeof merged.licznikSlowek !== 'number' || !isFinite(merged.licznikSlowek) || merged.licznikSlowek < 0) {
          merged.licznikSlowek = 0;
        }
        if (typeof merged.licznikLiter !== 'number' || !isFinite(merged.licznikLiter) || merged.licznikLiter < 0) {
          merged.licznikLiter = 0;
        }
        if (typeof merged.licznikMarek !== 'number' || !isFinite(merged.licznikMarek) || merged.licznikMarek < 0) {
          merged.licznikMarek = 0;
        }
        return merged;
      }

      // Migracja ze starego zapisu v2 (gra z kupowaniem pracownikow/ulepszen).
      // Te dane juz nie maja sensu w grze dla czatu (nie ma czego kupowac),
      // wiec z calego zapisu ratujemy TYLKO tier automatu - reszta startuje od zera.
      const oldRaw = localStorage.getItem(OLD_SAVE_KEY);
      if (oldRaw) {
        const old = JSON.parse(oldRaw);
        const d = defaultState();
        if (typeof old.machineTier === 'number' && old.machineTier >= 0 && old.machineTier < MACHINE_TIERS.length) {
          d.machineTier = old.machineTier;
          // Zeby tier nie spadl przy pierwszym sprawdzeniu progu, dopasowujemy
          // tez licznik klikniec czatu do minimum wymaganego dla tego tieru.
          d.totalChatClicks = MACHINE_TIER_CLICK_THRESHOLDS[old.machineTier] || 0;
        }
        console.info('Zmigrowano zapis gry z v2 do v3 (gra dla widzow) - zachowano tylko tier automatu');
        return d;
      }
      return null;
    } catch (e) {
      console.warn('Nie udalo sie wczytac zapisu', e);
      return null;
    }
  }

  save() {
    this.state.lastSave = Date.now();
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.state));
    } catch (e) {
      console.warn('Nie udalo sie zapisac gry', e);
    }
  }

  reset() {
    this.state = defaultState();
    this._combo = 0;
    this._comboLastClickMs = 0;
    this.save();
  }

  machineMult() {
    return MACHINE_TIERS[this.state.machineTier].mult;
  }

  /** Wartosc bazowa pojedynczego klikniecia/tyknięcia - bez losowego krytyka i kombo. */
  baseClickValue() {
    return 1 * this.machineMult();
  }

  critChance() {
    return CRIT_CHANCE;
  }

  critMultFactor() {
    return CRIT_MULT;
  }

  comboMultFactor() {
    return 1 + Math.min(this._combo, COMBO_MAX) * COMBO_STEP;
  }

  comboCount() {
    return this._combo;
  }

  _updateCombo(nowMs) {
    if (nowMs - this._comboLastClickMs <= COMBO_WINDOW_MS) {
      this._combo = Math.min(COMBO_MAX, this._combo + 1);
    } else {
      this._combo = 0;
    }
    this._comboLastClickMs = nowMs;
  }

  /**
   * Sprawdza, czy laczna liczba klikniec z czatu przekroczyla prog kolejnego
   * tieru automatu. Jesli tak - awansuje automatycznie i zwraca numer nowego
   * tieru (main.js podmienia wtedy model 3D i pokazuje baner). Zwraca null,
   * jesli nie ma awansu.
   */
  _checkTierAdvance() {
    let target = this.state.machineTier;
    for (let t = MACHINE_TIER_CLICK_THRESHOLDS.length - 1; t > this.state.machineTier; t--) {
      if (this.state.totalChatClicks >= MACHINE_TIER_CLICK_THRESHOLDS[t]) {
        target = t;
        break;
      }
    }
    if (target === this.state.machineTier) return null;
    this.state.machineTier = target;
    return target;
  }

  /**
   * Wykonuje klikniecie w automat: liczy kombo calego czatu, losuje krytyka,
   * dolicza kase do wspolnej puli. `isChatClick` = true oznacza, ze klikniecie
   * liczy sie do progu awansu tieru automatu. Wolaja z `true` OBIE sciezki:
   * komendy widzow z czatu ORAZ klikniecia wlasciciela myszka w model 3D
   * (patrz machine.onClickHit w main.js) - decyzja z commita "1 klikniecie =
   * 1 zl na kazdym tierze bankomatu". Domyslne `false` zostaje dla wywolan,
   * ktore maja tylko doliczyc kase, bez ruszania licznika awansu.
   *
   * `msgId` to id wiadomosci czatu Kicka, ktora wywolala to klikniecie (patrz
   * chatItem.id w src/kick.js) - trafienie krytyczne jest zakotwiczone w tym
   * id (strumien `${seedGry}:kryt:${msgId}`), wiec KAZDA otwarta karta gry,
   * widzac te sama wiadomosc, losuje DOKLADNIE ten sam wynik. Reczny klik
   * gracza (streamera) myszka w model nie ma zadnej wiadomosci czatu za soba
   * (msgId = null) - dotyczy WYLACZNIE jego wlasnej karty, wiec zostaje
   * zwykle, lokalnie losowe.
   */
  performClick(nowMs, isChatClick = false, msgId = null) {
    this._updateCombo(nowMs);
    const base = this.baseClickValue() * this.comboMultFactor();
    let isCrit;
    if (msgId) {
      const rng = strumien(`${this.state.seedGry}:kryt:${msgId}`);
      isCrit = rng() < this.critChance();
    } else {
      isCrit = Math.random() < this.critChance();
    }
    const value = isCrit ? base * this.critMultFactor() : base;
    this.addMoney(value);

    let tierAdvanced = null;
    if (isChatClick) {
      this.state.totalChatClicks += 1;
      tierAdvanced = this._checkTierAdvance();
    }

    return { value, isCrit, combo: this._combo, tierAdvanced };
  }

  /** Prog klikow otwierajacy kolejny tier bankomatu albo null, gdy osiagnieto ostatni. */
  nextTierThreshold() {
    const next = this.state.machineTier + 1;
    return next < MACHINE_TIER_CLICK_THRESHOLDS.length ? MACHINE_TIER_CLICK_THRESHOLDS[next] : null;
  }

  addMoney(amount) {
    this.state.money += amount;
    this.state.totalEarned += amount;
  }
}
