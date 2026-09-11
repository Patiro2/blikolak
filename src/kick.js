/**
 * Klient czatu Kick.com oparty o protokół WebSocket Pusher.
 *
 * Kick używa klastra Pusher (ws-us2.pusher.com) do streamowania czatu.
 * Dla kanału 'patiro' ID pokoju czatu (chatroom_id) to 37663.
 */

const PUSHER_APP_KEY = '32cbd69e4b950bf97679';
const PUSHER_CLUSTER = 'us2';
const DEFAULT_CHATROOM_ID = 37663; // chatroom_id dla kanalu patiro
const LEADERBOARD_KEY = 'bankomat-clicker-kick-leaderboard';
const ASSIGNMENTS_KEY = 'bankomat-clicker-worker-assignments';

// Przy spamie na czacie (np. 200 wiadomosci "klik" w ciagu kilku sekund) nie
// chcemy zapisywac do localStorage ani przerysowywac rankingu przy KAZDEJ
// wiadomosci - to marnotrawstwo. Zapis idzie z debounce, a wywolanie
// onLeaderboardUpdate (ktore uruchamia przerysowanie UI i sync awatarow) jest
// ograniczone do co najwyzej raz na UPDATE_THROTTLE_MS, z gwarantowanym
// wywolaniem koncowym (trailing), zeby ostatni stan zawsze byl odswiezony.
const SAVE_DEBOUNCE_MS = 1000;
const UPDATE_THROTTLE_MS = 250;

export class KickChatClient {
  constructor(options = {}) {
    this.chatroomId = options.chatroomId || DEFAULT_CHATROOM_ID;
    this.channelName = options.channelName || 'patiro';

    this.onMessage = options.onMessage || (() => {});
    this.onKlik = options.onKlik || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onLeaderboardUpdate = options.onLeaderboardUpdate || (() => {});
    this.onTopWorkerChat = options.onTopWorkerChat || (() => {});

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

    this.leaderboard = this._loadLeaderboard();
    this.assignments = this._loadAssignments();
    this.updateAssignments();

    // Widzowie "wyeliminowani" przez bossa (patrz boss.js) - stan runtime,
    // NIE zapisywany do localStorage. Dopoki trwa walka z bossem, nie moga
    // wrocic do rankingu (recordEarned/creditRecoveredMoney je ignoruja).
    this.eliminated = new Set();
  }

  _loadLeaderboard() {
    try {
      const raw = localStorage.getItem(LEADERBOARD_KEY);
      return raw ? JSON.parse(raw) : {};
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
    const top10Keys = new Set(top10.map((u) => u.username.toLowerCase()));

    // 1. Eviction: usunięcie widzów, którzy wypadli poza Top 10
    for (const uKey of Object.keys(this.assignments.userToWorker)) {
      if (!top10Keys.has(uKey)) {
        const freedSlot = this.assignments.userToWorker[uKey];
        delete this.assignments.userToWorker[uKey];
        delete this.assignments.workerToUser[freedSlot];
      }
    }

    // 2. Przypisanie wolnych slotów dla nowych osób w Top 10 (z zachowaniem istniejących slotów)
    for (const user of top10) {
      const uKey = user.username.toLowerCase();
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
    const data = this.assignments.workerToUser[workerIndex];
    if (!data) return null;
    const topEarners = this.getTopEarners(100);
    const rankIndex = topEarners.findIndex((u) => u.username.toLowerCase() === data.username.toLowerCase());
    return {
      username: data.username,
      color: data.color || '#53fc18',
      rank: rankIndex >= 0 ? rankIndex + 1 : null,
    };
  }

  getWorkerForUser(username) {
    if (!username) return null;
    const slot = this.assignments.userToWorker[username.toLowerCase()];
    return slot !== undefined ? slot : null;
  }

  recordEarned(username, amount, color) {
    if (!username) return;
    const key = username.toLowerCase();
    if (this.eliminated.has(key)) return; // zabici przez bossa nie wracaja do rankingu w trakcie walki

    if (!this.leaderboard[key]) {
      this.leaderboard[key] = {
        username,
        totalEarned: 0,
        clicks: 0,
        color: color || '#53fc18',
        lastActive: Date.now(),
      };
    }
    const entry = this.leaderboard[key];
    entry.username = username;
    entry.totalEarned += amount;
    entry.clicks += 1;
    if (color) entry.color = color;
    entry.lastActive = Date.now();

    this._saveLeaderboard();
    this.updateAssignments();
    this._scheduleLeaderboardUpdate();
  }

  /**
   * Kradnie okreslona kwote zl z dorobku (totalEarned) widza. Nie rusza
   * pola `clicks` - ono zostaje niezalezna statystyka liczby komend "klik".
   * Zwraca faktycznie skradzioną kwotę (obcięta do tego, co widz ma).
   */
  stealMoneyFromUser(username, amount = 0) {
    if (!username) return 0;
    const key = username.toLowerCase();
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
   * ale nigdy nie pisal "klik").
   */
  creditRecoveredMoney(username, amount = 0, color) {
    if (!username || amount <= 0) return;
    const key = username.toLowerCase();
    if (this.eliminated.has(key)) return; // zabici przez bossa nie wracaja do rankingu w trakcie walki

    if (!this.leaderboard[key]) {
      this.leaderboard[key] = {
        username,
        totalEarned: 0,
        clicks: 0,
        color: color || '#53fc18',
        lastActive: Date.now(),
      };
    }
    const entry = this.leaderboard[key];
    entry.username = username;
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
   * "Zabicie" widza przez bossa (patrz boss.js, timeout dzialania matematycznego):
   * traci caly dorobek, znika z rankingu, zwalnia sie jego przypisany pracownik,
   * a jego nick trafia do this.eliminated - dopoki trwa walka, nie moze wrocic
   * do rankingu (patrz guard w recordEarned/creditRecoveredMoney).
   */
  eliminateUser(username) {
    if (!username) return;
    const key = username.toLowerCase();
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
    this.stats.kliksReceived = 0;
    try {
      localStorage.removeItem(LEADERBOARD_KEY);
      localStorage.removeItem(ASSIGNMENTS_KEY);
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
    const username = sender.username || 'Anonim';
    const userColor = sender.identity?.color || '#53fc18';

    // Sprawdzenie czy wiadomość to komenda "klik" (lub "!klik", "klik!", "click")
    const cleanContent = content.toLowerCase().replace(/^[!/]/, '').trim();
    const isKlik = cleanContent === 'klik' || cleanContent === 'click' || cleanContent.startsWith('klik ');

    const chatItem = {
      id: msg.id || Math.random().toString(36).slice(2),
      username,
      color: userColor,
      content,
      isKlik,
      badges: sender.identity?.badges_v2 || [],
      createdAt: msg.created_at || new Date().toISOString(),
    };

    if (isKlik) {
      this.stats.kliksReceived += 1;
      this.onKlik(sender, chatItem);
    }

    // Jeśli autor wiadomości jest w Top 10 i posiada przypisanego pracownika,
    // wywołujemy zdarzenie dymka wypowiedzi nad głową jego postaci w 3D.
    // Filtrujemy wiadomości tak, aby słowo "klik" nigdy nie pojawiało się nad głowami postaci.
    const assignedWorkerIdx = this.getWorkerForUser(username);
    if (assignedWorkerIdx !== null) {
      const filteredContent = content
        .replace(/(?:^|\s)[!/]*klik+[!.,?*~]*(?=\s|$)/gi, '')
        .replace(/(?:^|\s)[!/]*click+[!.,?*~]*(?=\s|$)/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

      if (filteredContent.length > 0) {
        this.onTopWorkerChat({
          workerIndex: assignedWorkerIdx,
          username,
          content: filteredContent,
          color: userColor,
        });
      }
    }

    this.onMessage(chatItem);
  }

  /**
   * Metoda symulacji - przydatna do testów lokalnych lub offline.
   */
  simulate(username = 'TestViewer', text = 'klik') {
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
