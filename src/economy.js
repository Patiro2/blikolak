// Ekonomia gry dla widzow streama - CALA progresja dzieje sie sama w reakcji
// na aktywnosc czatu Kick.com. Gracz (streamer) nic nie kupuje - klika tylko
// czasem sam, a widzowie napedzaja postep pisac "klik" na czacie.

export const SAVE_KEY = 'bankomat-clicker-v3';
const OLD_SAVE_KEY = 'bankomat-clicker-v2'; // stary zapis z systemem kupowania - migrujemy tylko tier automatu

export const MACHINE_TIERS = [
  { key: 'gambling-machine', name: 'Automat hazardowy', mult: 1 },
  { key: 'vending-machine', name: 'Automat vendingowy', mult: 3 },
  { key: 'ticket-machine', name: 'Automat biletowy', mult: 10 },
  { key: 'arcade-machine', name: 'Automat arcade', mult: 35 },
  { key: 'claw-machine', name: 'Automat ze szczypcami', mult: 120 },
  { key: 'dance-machine', name: 'Automat taneczny', mult: 500 },
];

// Progi LACZNEJ liczby klikniec z czatu potrzebne do awansu na dany tier
// automatu (indeks = tier, tier 0 jest odblokowany od razu). Awans jest
// automatyczny - gdy suma klikniec z czatu przekroczy prog, bankomat sam
// podmienia model i pokazuje baner na gorze ekranu (patrz main.js).
export const MACHINE_TIER_CLICK_THRESHOLDS = [0, 100, 500, 2000, 8000, 25000];

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

function defaultState() {
  return {
    money: 0, // wspolna pula czatu (nie portfel gracza!)
    totalEarned: 0, // suma wszystkiego, co kiedykolwiek wplynelo do puli
    totalChatClicks: 0, // laczna liczba klikniec "klik" z czatu - napedza awans tieru
    machineTier: 0,
    bossesDefeated: [], // numery tierow, dla ktorych boss zostal juz pokonany (anty-powtorka)
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
   * dolicza kase do wspolnej puli. `isChatClick` = true dla klikniec widzow
   * (napedzaja awans tieru automatu), false dla reczengo klikniecia streamera
   * w model 3D (dolicza kase, ale NIE liczy sie do progu awansu tieru).
   */
  performClick(nowMs, isChatClick = false) {
    this._updateCombo(nowMs);
    const base = this.baseClickValue() * this.comboMultFactor();
    const isCrit = Math.random() < this.critChance();
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
