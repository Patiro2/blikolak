/**
 * Klient czatu Kick.com oparty o protokół WebSocket Pusher.
 *
 * Kick używa klastra Pusher (ws-us2.pusher.com) do streamowania czatu.
 * Dla kanału 'patiro' ID pokoju czatu (chatroom_id) to 37663.
 */

import { showTopAnnouncement } from './vanessa.js';
import { isValidSkin } from './skiny.js';

const PUSHER_APP_KEY = '32cbd69e4b950bf97679';
const PUSHER_CLUSTER = 'us2';
const DEFAULT_CHATROOM_ID = 37663; // chatroom_id dla kanalu patiro
export const LEADERBOARD_KEY = 'bankomat-clicker-kick-leaderboard';
export const ASSIGNMENTS_KEY = 'bankomat-clicker-worker-assignments';
export const JOINED_KEY = 'bankomat-clicker-kick-joined';

// Przy spamie na czacie (np. 200 wiadomosci "klik" w ciagu kilku sekund) nie
// chcemy zapisywac do localStorage ani przerysowywac rankingu przy KAZDEJ
// wiadomosci - to marnotrawstwo. Zapis idzie z debounce, a wywolanie
// onLeaderboardUpdate (ktore uruchamia przerysowanie UI i sync awatarow) jest
// ograniczone do co najwyzej raz na UPDATE_THROTTLE_MS, z gwarantowanym
// wywolaniem koncowym (trailing), zeby ostatni stan zawsze byl odswiezony.
const SAVE_DEBOUNCE_MS = 1000;
const UPDATE_THROTTLE_MS = 250;

/**
 * Usuwa poprzedzajace "@" i biale znaki z nicku, zachowujac oryginalna
 * wielkosc liter (do wyswietlania, np. jako "username" w rankingu).
 */
export function stripNickPrefix(username) {
  return String(username || '').replace(/^@+/, '').trim();
}

/**
 * Normalizuje nick widza do postaci uzywanej jako klucz porownan/mapowan w
 * calej grze: usuwa "@", przycina biale znaki, sprowadza do malych liter.
 * Uzywane wszedzie tam, gdzie porownujemy nicki (ranking, przypisania
 * pracownikow, omdlenia bossa, ratunek "pomoc") - bez tej jednej wspolnej
 * funkcji nick z "@" (np. wpisany recznie) rozjezdzal sie z reszta systemu
 * (patrz boss.js _tryHelp/isFainted, ktore kiedys robily surowe .toLowerCase()).
 */
export function normalizeNick(username) {
  return stripNickPrefix(username).toLowerCase();
}

/**
 * Oczyszcza nick widza do bezpiecznego podzbioru znakow, jakie Kick w ogole
 * dopuszcza w nazwach: litery (TAKZE spoza ASCII - "Jozek" z "o" kreskowanym
 * ma zostac soba, nie "Jzek"), cyfry, "_", "-", ".". Wszystko inne jest
 * wycinane. To JEDYNY strażnik na granicy zaufania - nick z czatu trafia
 * pozniej do innerHTML w kilkunastu miejscach (vanessa.js, ui.js, minigry,
 * wilkolak-zwyciestwo.js), wiec musi byc oczyszczony RAZ, tutaj, zanim
 * wejdzie do reszty gry. Pusty wynik po oczyszczeniu -> 'Anonim'. Dlugosc
 * ograniczona do 32 znakow, zeby nick z setek znakow nie rozwalal ukladu
 * plakietki/dymka.
 */
export function czystyNick(username) {
  const czysty = String(username || '').replace(/[^\p{L}\p{N}_.-]/gu, '').slice(0, 32);
  return czysty || 'Anonim';
}

// Nicki botow czatu, ktore NIE moga wchodzic do gry (klik, ranking, kody,
// komendy) - patrz czyZablokowany i jej uzycie w _processChatMessage.
const ZABLOKOWANE_NICKI = new Set(['botrix']);

/** Czy dany nick (w dowolnej wielkosci liter, z ew. "@") jest zablokowanym botem czatu. */
export function czyZablokowany(username) {
  return ZABLOKOWANE_NICKI.has(normalizeNick(username));
}

// [emote:ID:NAZWA] - ID MUSI byc \d+, bo leci prosto do URL-a, a tresc czatu
// jest niezaufana; dowolny znak pozwolilby podmienic adres obrazka.
const RE_EMOTE = /\[emote:(\d+):([^\]]*)\]/g;

/**
 * Rozbija tresc wiadomosci czatu na tablice wezlow DOM: tekst jako
 * text node, tagi emotek [emote:ID:NAZWA] jako <img>. Adres obrazka to
 * stale URL Kicka (files.kick.com/emotes/<ID>/fullsize) - nie trzeba
 * pobierac zadnej listy emotek ani wolac API.
 *
 * maxEmotek (opcjonalne) ogranicza liczbe RENDEROWANYCH obrazkow - po
 * przekroczeniu limitu kolejne tagi leca jako zwykly tekst ":NAZWA:",
 * zeby spam z dziesiatkami emotek nie rozsadzil np. dymka nad glowa.
 */
export function wezlyZTrescia(tresc, { maxEmotek } = {}) {
  const wynik = [];
  const surowa = String(tresc || '');
  let lastIndex = 0;
  let liczbaEmotek = 0;

  // Uzywamy matchAll (swiezy iterator, wlasny stan lastIndex) zamiast
  // RE_EMOTE.test()/exec() w petli na dzielonym module-level regexie -
  // to klasyczny bug, gdzie zapomniany/przeterminowany lastIndex gubi
  // dopasowania przy kolejnych wywolaniach.
  for (const dopasowanie of surowa.matchAll(RE_EMOTE)) {
    const [pelny, id, nazwa] = dopasowanie;
    const indeks = dopasowanie.index;

    if (indeks > lastIndex) {
      wynik.push(document.createTextNode(surowa.slice(lastIndex, indeks)));
    }

    if (maxEmotek == null || liczbaEmotek < maxEmotek) {
      const img = document.createElement('img');
      img.className = 'kick-emote';
      img.src = `https://files.kick.com/emotes/${id}/fullsize`;
      img.alt = nazwa;
      img.loading = 'lazy';
      wynik.push(img);
      liczbaEmotek += 1;
    } else {
      wynik.push(document.createTextNode(`:${nazwa}:`));
    }

    lastIndex = indeks + pelny.length;
  }

  if (lastIndex < surowa.length) {
    wynik.push(document.createTextNode(surowa.slice(lastIndex)));
  }

  return wynik;
}

/**
 * Usuwa tagi [emote:ID:NAZWA] z tresci wiadomosci, zbija wielokrotne
 * spacje i przycina brzegi. Uzywane wszedzie tam, gdzie tresc czatu jest
 * POROWNYWANA (odpowiedzi flagbattle/boss) - surowy tag rozjezdzalby
 * dopasowanie.
 */
export function usunTagiEmotek(tresc) {
  return String(tresc || '')
    // Spacja, nie pusty string: emotka bywa jedynym separatorem miedzy
    // slowami ("tak[emote:1:x]nie"), a sklejenie ich zepsulo by dopasowanie.
    // Podwojne spacje zbija nastepna linia.
    .replace(/\[emote:(\d+):([^\]]*)\]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Kody czatu w stylu GTA: widz pisze slowo-klucz (opcjonalnie z "!" na
 * poczatku), a jego wpis w rankingu dostaje trwaly efekt. Kazdy kod to jedna
 * funkcja modyfikujaca wpis rankingu (entry) - dopisanie kolejnego kodu to
 * jedna linijka nizej. Dopasowanie jest niewrazliwe na wielkosc liter i biale
 * znaki (patrz normalizeKodCzatu).
 */
const KODY = {
  aezakmi: (entry) => { entry.teczowyNick = true; },
};

function normalizeKodCzatu(content) {
  return String(content || '').trim().toLowerCase().replace(/^!/, '').trim();
}

export class KickChatClient {
  constructor(options = {}) {
    this.chatroomId = options.chatroomId || DEFAULT_CHATROOM_ID;
    this.channelName = options.channelName || 'patiro';

    this.onMessage = options.onMessage || (() => {});
    this.onKlik = options.onKlik || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onLeaderboardUpdate = options.onLeaderboardUpdate || (() => {});
    this.onTopWorkerChat = options.onTopWorkerChat || (() => {});
    // Sekretny kod czatu "rocketman" (patrz KODY nizej) - callback do managera
    // jetpacka (src/jetpack.js), NIE efekt rankingu jak reszta KODY.
    this.onRocketman = options.onRocketman || (() => {});

    this.ws = null;
    this.status = 'disconnected'; // 'connecting' | 'connected' | 'disconnected' | 'error'
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this._shouldReconnect = true;
    this.stats = {
      messagesReceived: 0,
      kliksReceived: 0,
    };

    this._saveTimer = null;
    this._updateThrottleTimer = null;
    this._lastUpdateEmit = 0;

    // Blokuje emisje onLeaderboardUpdate dopoki konstruktor nie skonczy -
    // updateAssignments()/eliminateUser() ponizej moga synchronicznie
    // wywolac _scheduleLeaderboardUpdate(), a wywolujacy jeszcze nie ma
    // przypisanej zmiennej `const kickChat` (TDZ ReferenceError w main.js).
    this._wKonstrukcji = true;

    this.leaderboard = this._loadLeaderboard();
    this.assignments = this._loadAssignments();
    // Widzowie, ktorzy napisali "!join" - klucz normalizeNick, wartosc true.
    // Trwaly i synchronizowany dokladnie jak leaderboard/assignments (patrz
    // _loadJoined/_flushSave nizej i zbierzStan/zastosujStanZSerwera w
    // main.js) - widz wchodzacy na strone ma widziec ten sam zbior co host.
    this.joined = this._loadJoined();
    this.updateAssignments();

    // Widzowie "wyeliminowani" przez bossa lub przez panel eliminacji
    // wlasciciela (patrz boss.js) - stan runtime, NIE zapisywany do
    // localStorage. Wpis tu NIE blokuje powrotu do rankingu - kolejne
    // "klik" tego widza od razu go z tego zbioru usuwa (patrz recordEarned
    // nizej) i zaczyna go liczyc od zera. Zbior sluzy tylko do odrozniania
    // "wlasnie wyeliminowany" od "nigdy nie klikal" w krotkim oknie miedzy
    // eliminacja a nastepnym klikiem.
    this.eliminated = new Set();

    // Sprzatanie: bot moglby juz miec wpis w rankingu/przypisaniach z czasu
    // przed wprowadzeniem blokady (patrz ZABLOKOWANE_NICKI) - usuwamy go tu,
    // eliminateUser usuwa zarowno z leaderboard jak i z assignments naraz.
    for (const key of new Set([
      ...Object.keys(this.leaderboard),
      ...Object.keys(this.assignments.userToWorker),
    ])) {
      if (czyZablokowany(key)) this.eliminateUser(key);
    }

    this._wKonstrukcji = false;
  }

  _loadLeaderboard() {
    try {
      const raw = localStorage.getItem(LEADERBOARD_KEY);
      const wczytany = raw ? JSON.parse(raw) : {};
      // Ranking mogl zostac zapisany PRZED wprowadzeniem czystyNick - przepuszczamy
      // kazdy wpis przez nia teraz, zeby stare, niebezpieczne nicki tez zostaly oczyszczone.
      for (const entry of Object.values(wczytany)) {
        if (entry && typeof entry === 'object') {
          entry.username = czystyNick(entry.username);
        }
      }
      return wczytany;
    } catch (_) {
      return {};
    }
  }

  /** Zapis leaderboardu - przechodzi przez wspolny debounce (patrz _scheduleSave). */
  _saveLeaderboard() {
    this._scheduleSave();
  }

  _loadAssignments() {
    try {
      const raw = localStorage.getItem(ASSIGNMENTS_KEY);
      return raw ? JSON.parse(raw) : { userToWorker: {}, workerToUser: {} };
    } catch (_) {
      return { userToWorker: {}, workerToUser: {} };
    }
  }

  /** Zapis przypisan pracownikow - przechodzi przez wspolny debounce (patrz _scheduleSave). */
  _saveAssignments() {
    this._scheduleSave();
  }

  _loadJoined() {
    try {
      const raw = localStorage.getItem(JOINED_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  /** Zapis zbioru dolaczonych widzow - przechodzi przez wspolny debounce (patrz _scheduleSave). */
  _saveJoined() {
    this._scheduleSave();
  }

  /**
   * Debounce zapisow do localStorage: kazda wiadomosc na czacie wywoluje
   * leaderboard + assignments save, ale przy spamie (np. 200 "klik" pod rzad)
   * nie ma sensu robic pelnego JSON.stringify + setItem przy KAZDEJ z nich.
   * Zapis realny leci najwyzej raz na SAVE_DEBOUNCE_MS (trailing).
   */
  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Natychmiastowy, synchroniczny zapis obu kluczy - uzyj przy resecie/wyjsciu ze strony. */
  _flushSave() {
    try {
      localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(this.leaderboard));
    } catch (_) {}
    try {
      localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(this.assignments));
    } catch (_) {}
    try {
      localStorage.setItem(JOINED_KEY, JSON.stringify(this.joined));
    } catch (_) {}
  }

  /** Wymusza natychmiastowy zapis, anulujac oczekujacy debounce (np. przy zamknieciu karty). */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._flushSave();
    }
  }

  /**
   * Stabilne przypisanie pracowników dla Top 10 widzów:
   * - Zmiany pozycji wewnątrz Top 10 (np. z 5 na 4) NIE ZMIENIAJĄ przypisanego pracownika.
   * - Pracownik zwalnia się wyłącznie, gdy widz spadnie poza Top 10 (> 10 miejsce).
   * - Nowy widz wkraczający do Top 10 otrzymuje pierwszy zwolniony slot pracownika.
   */
  updateAssignments() {
    const top10 = this.getTopEarners(10);
    const top10Keys = new Set(top10.map((u) => normalizeNick(u.username || '')));

    // 1. Eviction: usunięcie widzów, którzy wypadli poza Top 10
    for (const uKey of Object.keys(this.assignments.userToWorker)) {
      if (!top10Keys.has(uKey)) {
        const freedSlot = this.assignments.userToWorker[uKey];
        delete this.assignments.userToWorker[uKey];
        delete this.assignments.workerToUser[freedSlot];
      }
    }

    // 1b. Eviction osieroconych slotów w workerToUser (np. po dawnych sesjach)
    for (const slotKey of Object.keys(this.assignments.workerToUser)) {
      const data = this.assignments.workerToUser[slotKey];
      if (!data || !data.username) {
        delete this.assignments.workerToUser[slotKey];
      } else {
        const cleanUser = normalizeNick(data.username);
        if (!top10Keys.has(cleanUser)) {
          delete this.assignments.workerToUser[slotKey];
        }
      }
    }

    // 2. Przypisanie wolnych slotów dla nowych osób w Top 10 (z zachowaniem istniejących slotów)
    for (const user of top10) {
      const uKey = normalizeNick(user.username || '');
      if (this.assignments.userToWorker[uKey] === undefined) {
        // Szukamy pierwszego wolnego slotu pracownika (0..9)
        for (let slot = 0; slot < 10; slot++) {
          if (!this.assignments.workerToUser[slot]) {
            this.assignments.userToWorker[uKey] = slot;
            this.assignments.workerToUser[slot] = { username: user.username, color: user.color };
            break;
          }
        }
      } else {
        // Widz już ma slot - nie zmieniamy go! Aktualizujemy jedynie kolor i pisownię nicku.
        const existingSlot = this.assignments.userToWorker[uKey];
        if (this.assignments.workerToUser[existingSlot]) {
          this.assignments.workerToUser[existingSlot].username = user.username;
          if (user.color) this.assignments.workerToUser[existingSlot].color = user.color;
        }
      }
    }

    this._saveAssignments();
  }

  /**
   * Wywoluje onLeaderboardUpdate (co uruchamia przerysowanie rankingu w UI
   * oraz syncLeaderboardAndOverlays w main.js), ale co najwyzej raz na
   * UPDATE_THROTTLE_MS. Gwarantowane wywolanie koncowe (trailing), zeby po
   * serii wiadomosci UI zawsze dogonilo ostatni stan.
   */
  _scheduleLeaderboardUpdate() {
    if (this._wKonstrukcji) return;
    const now = Date.now();
    const elapsed = now - this._lastUpdateEmit;
    if (elapsed >= UPDATE_THROTTLE_MS) {
      this._lastUpdateEmit = now;
      this.onLeaderboardUpdate(this.getTopEarners());
      return;
    }
    if (this._updateThrottleTimer) return;
    this._updateThrottleTimer = setTimeout(() => {
      this._updateThrottleTimer = null;
      this._lastUpdateEmit = Date.now();
      this.onLeaderboardUpdate(this.getTopEarners());
    }, UPDATE_THROTTLE_MS - elapsed);
  }

  getUserForWorker(workerIndex) {
    workerIndex = Number(workerIndex);
    const data = this.assignments.workerToUser[workerIndex];
    if (!data) return null;
    const topEarners = this.getTopEarners(100);
    const cleanUser = normalizeNick(data.username || '');
    const rankIndex = topEarners.findIndex((u) => normalizeNick(u.username || '') === cleanUser);
    return {
      username: data.username,
      color: data.color || '#53fc18',
      rank: rankIndex >= 0 ? rankIndex + 1 : null,
      wygraneMinigry: this.leaderboard[cleanUser]?.wygraneMinigry || 0,
      teczowyNick: !!this.leaderboard[cleanUser]?.teczowyNick,
      // Skin wybrany komenda czatu "!skin <nazwa>" (patrz SKINS w skiny.js i
      // obsluga ponizej w _processChatMessage) - null = domyslny model roli.
      skin: this.leaderboard[cleanUser]?.skin || null,
    };
  }

  /**
   * Zwyciestwo w minigrze (flagbattle/tlumaczenia) - dolicza gwiazdke do
   * wpisu rankingu zwyciezcy. Zwyciezca zawsze ma juz wpis (jest w Top 10),
   * wiec brak wpisu nic nie robi (nie tworzymy "sierocego" wpisu).
   */
  zapiszWygranaMinigry(username) {
    if (!username) return;
    const key = normalizeNick(username);
    const entry = this.leaderboard[key];
    if (!entry) return;
    entry.wygraneMinigry = (entry.wygraneMinigry || 0) + 1;
    this._saveLeaderboard();
    this._scheduleLeaderboardUpdate();
  }

  getWorkerForUser(username) {
    if (!username) return null;
    const clean = normalizeNick(username);
    const slot = this.assignments.userToWorker[clean];
    return slot !== undefined ? Number(slot) : null;
  }

  isEliminated(username) {
    if (!username) return false;
    const clean = normalizeNick(username);
    return this.eliminated.has(clean);
  }

  /** Czy widz uprzednio napisal "!join" (patrz _processChatMessage). */
  isJoined(username) {
    if (!username) return false;
    return !!this.joined[normalizeNick(username)];
  }

  /**
   * Dolicza zarobek widzowi w rankingu. `countsAsClick` (domyslnie true)
   * decyduje, czy ten zarobek zwieksza tez licznik `clicks` w rankingu -
   * ten licznik MUSI odzwierciedlac wylacznie realne wiadomosci z czatu.
   * Zrodla zarobku inne niz wiadomosc na czacie (np. zebranie zlotej monety
   * przez dobiegniecie postaci) wywoluja to z countsAsClick=false, zeby nie
   * fabrykowac klikniec, ktorych widz nigdy nie napisal.
   */
  recordEarned(username, amount, color, countsAsClick = true) {
    if (!username) return;
    const cleanUsername = stripNickPrefix(username);
    const key = cleanUsername.toLowerCase();
    // Jeśli gracz zginął podczas walki z bossem, kolejna wiadomosc odradza
    // go w grze z nowym dorobkiem, pozwalając ponownie dołączyć do Top 10
    if (this.eliminated.has(key)) {
      this.eliminated.delete(key);
    }

    if (!this.leaderboard[key]) {
      this.leaderboard[key] = {
        username: cleanUsername,
        totalEarned: 0,
        clicks: 0,
        color: color || '#53fc18',
        lastActive: Date.now(),
      };
    }
    const entry = this.leaderboard[key];
    entry.username = cleanUsername;
    entry.totalEarned += amount;
    if (countsAsClick) entry.clicks += 1;
    if (color) entry.color = color;
    entry.lastActive = Date.now();

    this._saveLeaderboard();
    this.updateAssignments();
    this._scheduleLeaderboardUpdate();
  }

  /**
   * Kradnie okreslona kwote zl z dorobku (totalEarned) widza. Nie rusza
   * pola `clicks` - ono zostaje niezalezna statystyka liczby wiadomosci-klikow.
   * Zwraca faktycznie skradzioną kwotę (obcięta do tego, co widz ma).
   */
  stealMoneyFromUser(username, amount = 0) {
    if (!username) return 0;
    const key = normalizeNick(username);
    const entry = this.leaderboard[key];
    if (!entry) return 0;

    const stolen = Math.min(entry.totalEarned, Math.max(0, amount));
    entry.totalEarned = Math.max(0, entry.totalEarned - stolen);

    this._saveLeaderboard();
    this.updateAssignments();
    this._scheduleLeaderboardUpdate();

    return stolen;
  }

  /**
   * Dopisuje widzowi odzyskaną kwotę zl (np. czesc odebrana Vanessie).
   * To NIE jest swiezy zarobek - nie zwieksza licznika `clicks`. Tworzy
   * wpis w rankingu, jesli widz jeszcze go nie mial (np. odebral haslem,
   * ale nigdy nic nie pisal na czacie).
   */
  creditRecoveredMoney(username, amount = 0, color) {
    if (!username || amount <= 0) return;
    const cleanUsername = stripNickPrefix(username);
    const key = cleanUsername.toLowerCase();
    if (this.eliminated.has(key)) {
      this.eliminated.delete(key);
    }

    if (!this.leaderboard[key]) {
      this.leaderboard[key] = {
        username: cleanUsername,
        totalEarned: 0,
        clicks: 0,
        color: color || '#53fc18',
        lastActive: Date.now(),
      };
    }
    const entry = this.leaderboard[key];
    entry.username = cleanUsername;
    entry.totalEarned += amount;
    if (color) entry.color = color;
    entry.lastActive = Date.now();

    this._saveLeaderboard();
    this.updateAssignments();
    this._scheduleLeaderboardUpdate();
  }

  getTopEarners(limit = 25) {
    return Object.values(this.leaderboard)
      .sort((a, b) => b.totalEarned - a.totalEarned)
      .slice(0, limit);
  }

  /**
   * "Zabicie" widza - przez rakiete bossa albo przez reczna eliminacje z
   * panelu wlasciciela (patrz boss.js, _killUser/killUserManual): traci caly
   * dorobek, znika z rankingu, zwalnia sie jego przypisany pracownik, a jego
   * nick trafia do this.eliminated. To NIE jest bana - wystarczy, ze widz
   * napisze kolejna wiadomosc, a recordEarned od razu usunie go z tego zbioru
   * i zacznie liczyc dorobek od zera (patrz komentarz przy this.eliminated
   * w konstruktorze).
   */
  eliminateUser(username) {
    if (!username) return;
    const key = normalizeNick(username);
    this.eliminated.add(key);
    delete this.leaderboard[key];

    const slot = this.assignments.userToWorker[key];
    if (slot !== undefined) {
      delete this.assignments.userToWorker[key];
      delete this.assignments.workerToUser[slot];
    }

    this._saveLeaderboard();
    this.updateAssignments();
    this._scheduleLeaderboardUpdate();
  }

  /** Koniec walki z bossem - eliminacje przestaja blokowac powrot do rankingu. */
  clearEliminated() {
    this.eliminated.clear();
  }

  /**
   * Pełny reset rankingu widzów i przypisań pracowników (np. przy restarcie gry)
   */
  reset() {
    // Anulujemy oczekujacy debounced zapis i throttlowane odswiezenie -
    // inaczej stary (sprzed resetu) stan potrafilby "wyskoczyc" z opoznieniem
    // i nadpisac to, co wlasnie wyczyscilismy.
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._updateThrottleTimer) {
      clearTimeout(this._updateThrottleTimer);
      this._updateThrottleTimer = null;
    }

    this.leaderboard = {};
    this.assignments = { userToWorker: {}, workerToUser: {} };
    this.eliminated.clear();
    // Wszyscy musza napisac "!join" od nowa po resecie (przycisk "Reset gry"
    // i pelny reset po game over bossow - patrz pelnyResetGry w main.js).
    this.joined = {};
    this.stats.kliksReceived = 0;
    try {
      localStorage.removeItem(LEADERBOARD_KEY);
      localStorage.removeItem(ASSIGNMENTS_KEY);
      localStorage.removeItem(JOINED_KEY);
    } catch (_) {}
    this._lastUpdateEmit = Date.now();
    this.onLeaderboardUpdate([]);
  }

  connect() {
    this._shouldReconnect = true;
    this._setStatus('connecting', 'Nawiązywanie połączenia z Kick.com...');

    const url = `wss://ws-${PUSHER_CLUSTER}.pusher.com/app/${PUSHER_APP_KEY}?protocol=7&client=js&version=8.4.0-rc2&flash=false`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error('[KickChat] Błąd inicjalizacji WebSocket:', err);
      this._setStatus('error', 'Błąd inicjalizacji WebSocket');
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[KickChat] Połączono z serwerem Pusher.');
    };

    this.ws.onmessage = (event) => {
      this._handleMessage(event.data);
    };

    this.ws.onerror = (err) => {
      console.warn('[KickChat] Błąd połączenia WebSocket:', err);
      this._setStatus('error', 'Błąd połączenia');
    };

    this.ws.onclose = (event) => {
      console.log(`[KickChat] Połączenie zamknięte (kod: ${event.code}).`);
      this._setStatus('disconnected', 'Rozłączono');
      if (this._shouldReconnect) {
        this._scheduleReconnect();
      }
    };
  }

  disconnect() {
    this._shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._setStatus('disconnected', 'Wyłączony');
  }

  _setStatus(status, message) {
    this.status = status;
    this.onStatusChange({ status, message, chatroomId: this.chatroomId, stats: this.stats });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(10000, 1000 * Math.pow(1.5, Math.min(this.reconnectAttempts, 5)));
    console.log(`[KickChat] Próba ponownego połączenia za ${(delay / 1000).toFixed(1)}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this._shouldReconnect) {
        this.connect();
      }
    }, delay);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _subscribeToChatroom() {
    const channel = `chatrooms.${this.chatroomId}.v2`;
    console.log(`[KickChat] Subskrypcja kanału: ${channel}`);
    this._send({
      event: 'pusher:subscribe',
      data: {
        auth: '',
        channel,
      },
    });
  }

  _handleMessage(rawData) {
    let packet;
    try {
      packet = JSON.parse(rawData);
    } catch (e) {
      console.warn('[KickChat] Niepoprawny format pakietu JSON:', rawData);
      return;
    }

    const { event, data } = packet;

    // Obsługa heartbeat (ping -> pong)
    if (event === 'pusher:ping') {
      this._send({ event: 'pusher:pong', data: {} });
      return;
    }

    // Nawiązanie połączenia na poziomie protokołu Pusher
    if (event === 'pusher:connection_established') {
      this.reconnectAttempts = 0;
      this._subscribeToChatroom();
      return;
    }

    // Potwierdzenie subskrypcji kanału czatu
    if (event === 'pusher_internal:subscription_succeeded') {
      console.log(`[KickChat] Subskrypcja kanału powiodła się: ${packet.channel}`);
      this._setStatus('connected', `Połączono z czatem (${this.channelName})`);
      return;
    }

    // Zdarzenie nowej wiadomości na czacie
    if (event === 'App\\Events\\ChatMessageEvent') {
      this._processChatMessage(data);
    }
  }

  _processChatMessage(dataStr) {
    let msg;
    try {
      msg = typeof dataStr === 'string' ? JSON.parse(dataStr) : dataStr;
    } catch (e) {
      console.warn('[KickChat] Błąd parsowania ChatMessageEvent data:', e);
      return;
    }

    this.stats.messagesReceived += 1;

    const content = (msg.content || '').trim();
    const sender = msg.sender || { username: 'Anonim', identity: { color: '#53fc18' } };
    const username = czystyNick(sender.username);
    const userColor = sender.identity?.color || '#53fc18';
    // Kopia sendera z oczyszczonym nickiem - main.js czyta sender.username
    // dalej w lancuchu (onKlik), wiec surowy nick nie moze tam przeciekac.
    const cleanSender = { ...sender, username };

    // Boty czatu (patrz ZABLOKOWANE_NICKI) nie wchodza do gry: zaden klik,
    // wpis w rankingu, kod, dymek nad glowa pracownika ani nawet wiadomosc w
    // widzecie czatu (onMessage) - bezpieczenstwo wazniejsze niz widocznosc
    // wiadomosci bota na czacie.
    if (czyZablokowany(username)) {
      return;
    }

    // Widz musi wpierw napisac "!join" (albo "/join"), zanim jego wiadomosci
    // licza sie jako klik/kod/skin/rocketman/dymek nad glowa - patrz
    // this.joined. Sprawdzamy PRZED przetworzeniem TEJ wiadomosci, wiec sama
    // wiadomosc "!join" tez NIE liczy sie jako klik. Widz i tak widzi swoja
    // wiadomosc w widzecie czatu (main.js onMessage robi kickUI.addMessage
    // PRZED sprawdzeniem chatItem.dolaczony === false) - tylko boss/vanessa/
    // minigry/ruch (reszta onMessage w main.js) sa pomijane dla niedolaczonych.
    const wasJoined = this.isJoined(username);
    if (!wasJoined) {
      if (/^[!/]join$/i.test(content)) {
        this.joined[normalizeNick(username)] = true;
        this._saveJoined();
        try {
          showTopAnnouncement('Dołączono do gry!', `${username} napisał !join i może teraz klikać`);
        } catch (err) {
          console.error('[KickChat] Blad w showTopAnnouncement (join):', err);
        }
      }
      const chatItem = {
        id: msg.id || Math.random().toString(36).slice(2),
        username,
        color: userColor,
        content,
        isKlik: false,
        dolaczony: false,
        badges: sender.identity?.badges_v2 || [],
        createdAt: msg.created_at || new Date().toISOString(),
      };
      try {
        this.onMessage(chatItem);
      } catch (err) {
        console.error('[KickChat] Blad w onMessage:', err);
      }
      return;
    }

    // Kazda niepusta wiadomosc na czacie liczy sie jako klik w bankomat.
    const isKlik = content.length > 0 && !/^[!/]join$/i.test(content); // ponowne !join nie jest klikiem

    const chatItem = {
      id: msg.id || Math.random().toString(36).slice(2),
      username,
      color: userColor,
      content,
      isKlik,
      badges: sender.identity?.badges_v2 || [],
      createdAt: msg.created_at || new Date().toISOString(),
    };

    // NAPRAWA: onKlik/onTopWorkerChat/onMessage sa callbackami zdefiniowanymi
    // w main.js i spinaja razem boss.js/vanessa.js/flagbattle.js/workers.js -
    // przed ta zmiana caly ten łańcuch szedł bez zadnego try/catch. Wyjatek w
    // KTORYMKOLWIEK z nich (np. boss.onChatMessage przy nietypowej tresci)
    // przerywal reszte obsluzenia TEJ wiadomosci "w polowie" - kolejne
    // callbacki w łańcuchu (w tym flagBattle.onChatMessage i samo
    // kickUI.addMessage w onMessage) nigdy by sie nie wykonaly dla tej
    // wiadomosci, a blad lecialby jako nieobsluzony wyjatek w konsoli. Kazdy
    // callback jest wiec teraz izolowany osobno - blad jednego nie kasuje
    // pozostalych, ani nie blokuje obslugi KOLEJNYCH wiadomosci z czatu.
    if (isKlik) {
      this.stats.kliksReceived += 1;
      try {
        this.onKlik(cleanSender, chatItem);
      } catch (err) {
        console.error('[KickChat] Blad w onKlik:', err);
      }

      // Kody czatu (patrz KODY) - dopasowanie PO onKlik, bo onKlik (przez
      // recordEarned w main.js) tworzy wpis w rankingu jesli widz go jeszcze
      // nie mial. Idempotentne - kolejne wpisanie tego samego kodu nic nie zmienia.
      const kod = KODY[normalizeKodCzatu(content)];
      if (kod) {
        const entry = this.leaderboard[normalizeNick(username)];
        if (entry) {
          kod(entry);
          chatItem.teczowyNick = !!entry.teczowyNick;
          this._saveLeaderboard();
          try {
            showTopAnnouncement('Kod aktywowany!', `${username} odblokował tęczowy nick`);
          } catch (err) {
            console.error('[KickChat] Blad w showTopAnnouncement:', err);
          }
        }
      }

      // Sekretny kod czatu "rocketman" (jak w GTA) - NIE wchodzi do KODY
      // powyzej, bo nie modyfikuje wpisu rankingu ani nie pokazuje banera
      // tęczowego nicku, tylko odpala jetpack na planszy (src/jetpack.js).
      // Nazwa celowo nie jest nigdzie dokumentowana (legenda/tutorial).
      if (normalizeKodCzatu(content) === 'rocketman') {
        try {
          this.onRocketman(username);
        } catch (err) {
          console.error('[KickChat] Blad w onRocketman:', err);
        }
      }

      // Komenda "!skin <nazwa>" (dziala tez bez "!") - podmienia model
      // awatara widza w Top 10 (patrz SKINS w skiny.js, uzycie w
      // getUserForWorker wyzej i workers.js addWorkerType). Nieznana nazwa
      // jest cicho ignorowana - bez spamu w czacie. Sama wiadomosc juz
      // policzyla sie jako klik wyzej (onKlik), to sie nie zmienia.
      // "!skin" bez argumentu albo "!skin reset" usuwa nadpisanie (wraca
      // domyslny model roli).
      const skinMatch = /^[!/]?skin(?:\s+(\S+))?$/i.exec(content.trim());
      if (skinMatch) {
        const entry = this.leaderboard[normalizeNick(username)];
        if (entry) {
          const arg = (skinMatch[1] || '').trim().toLowerCase();
          if (!arg || arg === 'reset') {
            if (entry.skin) {
              delete entry.skin;
              this._saveLeaderboard();
              this._scheduleLeaderboardUpdate();
            }
          } else if (isValidSkin(arg)) {
            entry.skin = arg;
            this._saveLeaderboard();
            this._scheduleLeaderboardUpdate();
            try {
              showTopAnnouncement('Nowy skin!', `${username} → ${arg}`);
            } catch (err) {
              console.error('[KickChat] Blad w showTopAnnouncement (skin):', err);
            }
          }
          // nieznana nazwa skina - nic sie nie dzieje
        }
      }
    }

    // Jeśli autor wiadomości jest w Top 10 i posiada przypisanego pracownika,
    // wywołujemy zdarzenie dymka wypowiedzi nad głową jego postaci w 3D.
    try {
      const assignedWorkerIdx = this.getWorkerForUser(username);
      if (assignedWorkerIdx !== null && content.length > 0) {
        this.onTopWorkerChat({
          workerIndex: assignedWorkerIdx,
          username,
          content,
          color: userColor,
        });
      }
    } catch (err) {
      console.error('[KickChat] Blad w onTopWorkerChat:', err);
    }

    try {
      this.onMessage(chatItem);
    } catch (err) {
      console.error('[KickChat] Blad w onMessage:', err);
    }
  }

  /**
   * Metoda symulacji - przydatna do testów lokalnych lub offline.
   */
  simulate(username = 'TestViewer', text = 'klik') {
    // Testy/symulacja: widz symulowany dolacza automatycznie, zeby nie trzeba
    // bylo osobno symulowac "!join" przed kazdym testem klikania.
    const key = normalizeNick(username);
    if (!this.joined[key]) {
      this.joined[key] = true;
      this._saveJoined();
    }
    this._processChatMessage({
      id: 'sim-' + Date.now(),
      content: text,
      sender: {
        username,
        identity: { color: '#00e701' },
      },
      created_at: new Date().toISOString(),
    });
  }
}
