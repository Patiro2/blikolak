import * as THREE from 'three';
import { fmt } from './format.js';
import { wezlyZTrescia } from './kick.js';

const NARROW_SCREEN_BREAKPOINT = 700;

/**
 * Na waskich ekranach (telefony) nieprzezroczyste panele HUD (czat Kicka,
 * ranking) potrafily razem zajac ponad 70% powierzchni ekranu i calkowicie
 * zaslonic scene 3D z bankomatem. Domyslnie zwijamy je do samego paska
 * naglowka (maja juz przyciski zwijania "–"/"+"), zeby srodek sceny zostal
 * widoczny od razu po wejsciu na wasky ekran.
 */
function collapseHudPanelsOnNarrowScreen() {
  if (typeof window === 'undefined' || window.innerWidth > NARROW_SCREEN_BREAKPOINT) return;
  const targets = [
    { panel: document.getElementById('kick-panel'), btn: document.getElementById('kick-toggle-btn') },
    { panel: document.getElementById('leaderboard-panel'), btn: document.getElementById('leaderboard-toggle-btn') },
  ];
  for (const { panel, btn } of targets) {
    if (!panel) continue;
    panel.classList.add('collapsed');
    if (btn) btn.textContent = '+';
  }
}

export class UI {
  constructor(economy, callbacks) {
    this.economy = economy;
    this.callbacks = callbacks;

    this.moneyEl = document.getElementById('money');
    this.incomeEl = document.getElementById('income');
    this.comboEl = document.getElementById('combo');
    this.floatersEl = document.getElementById('floaters');
    this.resetBtn = document.getElementById('reset-btn');

    this._bindReset();
    collapseHudPanelsOnNarrowScreen();

    this._lastMoneyRefresh = 0;
  }

  _bindReset() {
    this.resetBtn.addEventListener('click', () => {
      if (confirm('Na pewno zresetować grę? Cały postęp (pula czatu, ranking, tier automatu) zostanie utracony.')) {
        this.callbacks.onReset();
      }
    });
  }

  /** Wywoływać co klatkę - odświeża tylko liczby HUD-u, bez przebudowy DOM. */
  refreshNumbers(now) {
    if (now - this._lastMoneyRefresh < 100) return;
    this._lastMoneyRefresh = now;
    this.moneyEl.textContent = `${fmt(this.economy.state.money)} zł`;

    // W grze nie ma dochodu pasywnego, wiec zamiast "zl/s" pokazujemy licznik
    // klikow i postep do kolejnego tieru - to jedyne, co napedza progresje.
    // Licznik obejmuje kliki z czatu ORAZ klikniecia wlasciciela myszka w model
    // (pole nazywa sie historycznie totalChatClicks - nie zmieniamy nazwy, bo
    // siedzi w zapisanym stanie w localStorage i KV).
    const kliki = this.economy.state.totalChatClicks;
    const prog = this.economy.nextTierThreshold();
    this.incomeEl.textContent = prog === null
      ? `${fmt(kliki)} klików • maksymalny bankomat`
      : `${fmt(kliki)} / ${fmt(prog)} klików do awansu`;
    if (this.comboEl) {
      const combo = this.economy.comboCount();
      if (combo > 1) {
        this.comboEl.textContent = `Kombo czatu ×${this.economy.comboMultFactor().toFixed(2)} (${combo})`;
        this.comboEl.style.display = 'block';
      } else {
        this.comboEl.style.display = 'none';
      }
    }
  }

  /** Unoszący się napis +X w miejscu rzutowania punktu 3D na ekran. */
  spawnFloater(text, screenX, screenY, opts = {}) {
    const el = document.createElement('div');
    el.className = 'floater';
    if (opts.crit) el.classList.add('floater-crit');
    if (opts.gold) el.classList.add('floater-gold');
    if (opts.kick) el.classList.add('floater-kick');
    if (opts.steal) el.classList.add('floater-steal');
    el.textContent = text;
    el.style.left = `${screenX}px`;
    el.style.top = `${screenY}px`;
    this.floatersEl.appendChild(el);
    setTimeout(() => el.remove(), 1000);
  }
}

/**
 * Obsługa pływających okien z przeciąganiem (drag & drop) za nagłówek.
 * Obsługuje mysz i dotyk (PointerEvents z setPointerCapture),
 * zapobiega wyjściu poza krawędzie ekranu i zapamiętuje pozycję w localStorage.
 */
export function makeDraggable(panelEl, handleEl, storageKey = null) {
  if (!panelEl || !handleEl) return;

  handleEl.classList.add('floating-header');

  // Przywrócenie zapisanej pozycji
  if (storageKey) {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        let { x, y } = JSON.parse(saved);
        if (typeof x === 'number' && typeof y === 'number') {
          // Zabezpieczenie przed nakładaniem się rankingu na przyciski HUD w lewym górnym rogu
          if (storageKey === 'bankomat-clicker-leaderboard-pos' && x < 340 && y < 145) {
            y = 155;
          }
          const maxLeft = Math.max(10, window.innerWidth - 80);
          const maxTop = Math.max(10, window.innerHeight - 40);
          panelEl.style.left = `${Math.min(Math.max(10, x), maxLeft)}px`;
          panelEl.style.top = `${Math.min(Math.max(10, y), maxTop)}px`;
          panelEl.style.right = 'auto';
          panelEl.style.bottom = 'auto';
        }
      }
    } catch (_) {}
  }

  let isDragging = false;
  let startPointerX = 0;
  let startPointerY = 0;
  let initialPanelX = 0;
  let initialPanelY = 0;

  // Wysunięcie aktywnego okna na wierzch (z-index)
  const bringToFront = () => {
    let maxZ = 20;
    document.querySelectorAll('#leaderboard-panel, #kick-panel').forEach((el) => {
      const z = parseInt(window.getComputedStyle(el).zIndex || '10', 10);
      if (!isNaN(z) && z > maxZ) maxZ = z;
    });
    panelEl.style.zIndex = `${maxZ + 1}`;
  };

  panelEl.addEventListener('pointerdown', bringToFront);

  handleEl.addEventListener('pointerdown', (e) => {
    // Nie inicjujemy przeciągania przy kliknięciu w przyciski (np. zwiń) lub linki
    if (e.target.closest('button, a, input')) return;

    bringToFront();
    isDragging = true;
    panelEl.classList.add('panel-dragging');

    try {
      handleEl.setPointerCapture(e.pointerId);
    } catch (_) {}

    const rect = panelEl.getBoundingClientRect();
    startPointerX = e.clientX;
    startPointerY = e.clientY;
    initialPanelX = rect.left;
    initialPanelY = rect.top;

    panelEl.style.left = `${initialPanelX}px`;
    panelEl.style.top = `${initialPanelY}px`;
    panelEl.style.right = 'auto';
    panelEl.style.bottom = 'auto';
  });

  handleEl.addEventListener('pointermove', (e) => {
    if (!isDragging) return;

    const dx = e.clientX - startPointerX;
    const dy = e.clientY - startPointerY;

    let nextLeft = initialPanelX + dx;
    let nextTop = initialPanelY + dy;

    // Ograniczenie do obszaru ekranu
    const pad = 8;
    const panelWidth = panelEl.offsetWidth || 320;
    const maxLeft = Math.max(pad, window.innerWidth - panelWidth - pad);
    const maxTop = Math.max(pad, window.innerHeight - 40);

    nextLeft = Math.min(Math.max(pad, nextLeft), maxLeft);
    nextTop = Math.min(Math.max(pad, nextTop), maxTop);

    panelEl.style.left = `${nextLeft}px`;
    panelEl.style.top = `${nextTop}px`;
  });

  const stopDrag = (e) => {
    if (!isDragging) return;
    isDragging = false;
    panelEl.classList.remove('panel-dragging');

    try {
      if (e.pointerId !== undefined) {
        handleEl.releasePointerCapture(e.pointerId);
      }
    } catch (_) {}

    if (storageKey) {
      try {
        const rect = panelEl.getBoundingClientRect();
        localStorage.setItem(storageKey, JSON.stringify({ x: rect.left, y: rect.top }));
      } catch (_) {}
    }
  };

  handleEl.addEventListener('pointerup', stopDrag);
  handleEl.addEventListener('pointercancel', stopDrag);

  // Dostosowanie pozycji przy zmianie rozmiaru okna przeglądarki - TYLKO dla
  // okien, ktore uzytkownik kiedys recznie przeciagnal (maja zapisana pozycje).
  // Bez tego warunku ten listener walczyl z src/tutorial.js o pozycje
  // #leaderboard-panel: tutorial.js ustawia ranking zaraz pod soba, a ten kod
  // (nieswiadomy tej logiki) potrafil to nadpisac wlasnym "maxTop = wysokosc
  // okna - 40", co przy niskim ekranie wpychalo ranking z powrotem na
  // samouczek. Panel bez zapisanej pozycji nie jest "przeciagniety", wiec nie
  // ma czego tu bronic przed wyjsciem poza ekran - jego pozycje kontroluje
  // kto inny (domyslny CSS albo, dla rankingu, tutorial.js).
  window.addEventListener('resize', () => {
    if (storageKey) {
      try {
        if (!localStorage.getItem(storageKey)) return;
      } catch (_) {}
    }
    const rect = panelEl.getBoundingClientRect();
    const pad = 8;
    const panelWidth = panelEl.offsetWidth || 320;
    const maxLeft = Math.max(pad, window.innerWidth - panelWidth - pad);
    const maxTop = Math.max(pad, window.innerHeight - 40);

    let adjusted = false;
    let curLeft = rect.left;
    let curTop = rect.top;

    if (curLeft > maxLeft) {
      curLeft = maxLeft;
      adjusted = true;
    }
    if (curTop > maxTop) {
      curTop = maxTop;
      adjusted = true;
    }
    if (adjusted) {
      panelEl.style.left = `${curLeft}px`;
      panelEl.style.top = `${curTop}px`;
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
    }
  });
}

export class KickUI {
  constructor() {
    this.panel = document.getElementById('kick-panel');
    this.header = document.getElementById('kick-header');
    this.statusDot = document.getElementById('kick-status-dot');
    this.kliksBadge = document.getElementById('kick-kliks-badge');
    this.messagesEl = document.getElementById('kick-messages');
    this.toggleBtn = document.getElementById('kick-toggle-btn');

    this._maxMessages = 45;
    this._bindEvents();
    collapseHudPanelsOnNarrowScreen();

    if (this.panel && this.header) {
      makeDraggable(this.panel, this.header, 'bankomat-clicker-chat-pos');
    }
  }

  _bindEvents() {
    if (this.toggleBtn && this.panel) {
      this.toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.panel.classList.toggle('collapsed');
        this.toggleBtn.textContent = this.panel.classList.contains('collapsed') ? '+' : '–';
      });
    }
  }

  updateStatus(status, message) {
    if (!this.statusDot) return;
    this.statusDot.className = `status-${status}`;
    this.statusDot.title = message || status;
  }

  updateKliksCount(count) {
    if (!this.kliksBadge) return;
    let suffix = 'klików';
    if (count === 1) suffix = 'klik';
    else if (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20)) suffix = 'kliki';
    this.kliksBadge.textContent = `${count} ${suffix}`;
  }

  addMessage(msg) {
    if (!this.messagesEl) return;
    const div = document.createElement('div');
    div.className = 'kick-msg';

    const userSpan = document.createElement('span');
    userSpan.className = 'user';
    userSpan.classList.toggle('nick-teczowy', !!msg.teczowyNick);
    userSpan.style.color = msg.teczowyNick ? '' : (msg.color || '#53fc18');
    userSpan.textContent = msg.username + ':';
    div.appendChild(userSpan);

    const textSpan = document.createElement('span');
    textSpan.className = 'text';
    textSpan.appendChild(document.createTextNode(' '));
    for (const node of wezlyZTrescia(msg.content)) {
      textSpan.appendChild(node);
    }
    div.appendChild(textSpan);

    this.messagesEl.appendChild(div);

    while (this.messagesEl.children.length > this._maxMessages) {
      this.messagesEl.removeChild(this.messagesEl.firstChild);
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}

const KICK_EMBED_SRC = 'https://kick.com/popout/patiro/chat';

/**
 * Guzik otwierajacy oficjalny popout czatu Kicka w osobnym oknie - w
 * odroznieniu od #kick-panel (KickUI wyzej), ktory jest tylko-do-odczytu i
 * pokazuje wiadomosci wciagniete do gry.
 *
 * Wczesniej ta klasa obslugiwala caly osadzony panel z iframe (leniwe
 * ladowanie, zwijanie, przeciaganie) - wlasciciel uznal ramke za zbedna i
 * zostal tylko link/guzik w #hud (patrz index.html, #kick-chat-btn). Nazwa
 * klasy zostaje bez zmian, bo main.js importuje ja jako KickEmbedUI i wola
 * bezargumentowy konstruktor.
 *
 * Element w HTML to <a href="..." target="kick-czat-patiro">, wiec dziala
 * sam z siebie (bez JS) i nazwane okno docelowe sprawia, ze kolejne
 * klikniecia wracaja do tego samego okna. JS doklada tu tylko wymiar okienka
 * przez window.open - i tylko wtedy blokuje domyslna nawigacje linku (e.
 * preventDefault), gdy window.open faktycznie zwrocilo obiekt okna. Gdy
 * przegladarka zablokuje wyskakujace okno (zwroci falsy), nie blokujemy
 * zdarzenia - <a> i tak otworzy popout normalnym kliknieciem/nawigacja.
 */
export class KickEmbedUI {
  constructor() {
    this.btn = document.getElementById('kick-chat-btn');
    this._bindClick();
  }

  _bindClick() {
    if (!this.btn) return;
    this.btn.addEventListener('click', (e) => {
      const popup = window.open(KICK_EMBED_SRC, 'kick-czat-patiro', 'width=420,height=700');
      if (popup) {
        // udalo sie otworzyc okienko o zadanym rozmiarze - zwykla nawigacja linku juz niepotrzebna
        e.preventDefault();
      }
      // w przeciwnym razie (blokada wyskakujacych okien) zostawiamy domyslne
      // zachowanie <a> - otworzy popout jako zwykla nawigacje/nowa karte
    });
  }
}

export class LeaderboardUI {
  constructor() {
    this.panel = document.getElementById('leaderboard-panel');
    this.header = document.getElementById('leaderboard-header');
    this.listEl = document.getElementById('leaderboard-list');
    this.toggleBtn = document.getElementById('leaderboard-toggle-btn');

    if (this.toggleBtn && this.panel) {
      this.toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.panel.classList.toggle('collapsed');
        this.toggleBtn.textContent = this.panel.classList.contains('collapsed') ? '+' : '–';
      });
    }

    collapseHudPanelsOnNarrowScreen();

    if (this.panel && this.header) {
      makeDraggable(this.panel, this.header, 'bankomat-clicker-leaderboard-pos');
    }
  }

  render(topEarners = [], getWorkerNameForIndex = () => null, kickClient = null) {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';

    if (topEarners.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'leaderboard-empty';
      empty.innerHTML = 'Napisz <b>cokolwiek</b> na czacie Kicka,<br>aby zająć 1. miejsce w rankingu!';
      this.listEl.appendChild(empty);
      return;
    }

    topEarners.slice(0, 10).forEach((user, idx) => {
      const rank = idx + 1;
      const row = document.createElement('div');
      row.className = 'leaderboard-row';
      if (rank <= 3) row.classList.add(`rank-${rank}`);

      const left = document.createElement('div');
      left.className = 'left';

      const rankSpan = document.createElement('span');
      rankSpan.className = 'rank';
      rankSpan.textContent = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
      left.appendChild(rankSpan);

      const nickSpan = document.createElement('span');
      nickSpan.className = 'nick';
      nickSpan.classList.toggle('nick-teczowy', !!user.teczowyNick);
      nickSpan.style.color = user.teczowyNick ? '' : (user.color || '#53fc18');
      nickSpan.textContent = user.username;
      left.appendChild(nickSpan);

      // Gwiazdka z liczba wygranych minigier - tylko gdy > 0.
      if (user.wygraneMinigry > 0) {
        const starySpan = document.createElement('span');
        starySpan.className = 'gwiazdki-wygranych';
        starySpan.textContent = `⭐${user.wygraneMinigry}`;
        left.appendChild(starySpan);
      }

      // Etykieta przypisanego pracownika
      if (kickClient) {
        const workerSlot = kickClient.getWorkerForUser(user.username);
        if (workerSlot !== null) {
          const roleName = getWorkerNameForIndex(workerSlot);
          if (roleName) {
            const roleTag = document.createElement('span');
            roleTag.className = 'worker-tag';
            roleTag.textContent = roleName;
            left.appendChild(roleTag);
          }
        }
      }

      const right = document.createElement('div');
      right.className = 'right';

      const clicksSpan = document.createElement('span');
      clicksSpan.className = 'leaderboard-clicks';
      clicksSpan.textContent = `${user.clicks || 0} klików`;

      const moneySpan = document.createElement('span');
      moneySpan.className = 'leaderboard-money';
      moneySpan.textContent = `+${fmt(user.totalEarned)} zł`;

      right.appendChild(clicksSpan);
      right.appendChild(moneySpan);

      row.appendChild(left);
      row.appendChild(right);
      this.listEl.appendChild(row);
    });
  }
}

export class WorkerOverlayManager {
  constructor(containerEl) {
    this.container = containerEl || document.getElementById('worker-overlays');
    this.overlays = new Map();
    this._headWorld = new THREE.Vector3();
    this._projected = new THREE.Vector3();

    // Warstwa SVG na cienkie linie-lacznik miedzy plakietka a glowa postaci,
    // gdy plakietka zostala rozsunieta pionowo (patrz _rozsunNaGrupy nizej) -
    // bez tego widz nie wie, ktora rozsunieta plakietka nalezy do ktorej
    // postaci, gdy kilku graczy stoi na tym samym polu (lub na sasiednich
    // polach blisko siebie na ekranie). Ten sam kontener #worker-overlays
    // (position: fixed; inset: 0 - patrz style.css) wiec wspolrzedne pikselowe
    // (sx/sy ponizej) pasuja bez dodatkowych przeliczen.
    this.linesSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.linesSvg.setAttribute('class', 'worker-connector-layer');
    this.linesSvg.style.position = 'absolute';
    this.linesSvg.style.inset = '0';
    this.linesSvg.style.width = '100%';
    this.linesSvg.style.height = '100%';
    this.linesSvg.style.overflow = 'visible';
    this.linesSvg.style.pointerEvents = 'none';
    this.container.appendChild(this.linesSvg);
  }

  _getOrCreate(workerIndex) {
    if (this.overlays.has(workerIndex)) {
      return this.overlays.get(workerIndex);
    }
    const nameplateEl = document.createElement('div');
    nameplateEl.className = 'worker-nameplate';
    nameplateEl.style.display = 'none';

    const rankSpan = document.createElement('span');
    rankSpan.className = 'np-rank';
    nameplateEl.appendChild(rankSpan);

    const userSpan = document.createElement('span');
    userSpan.className = 'np-user';
    nameplateEl.appendChild(userSpan);

    // Gwiazdka z liczba wygranych minigier - utworzona raz tutaj, zeby
    // updateWorkerUser (wolane przy kazdej wiadomosci na czacie) tylko
    // aktualizowal jej tresc zamiast dokladac kolejne spany.
    const starySpan = document.createElement('span');
    starySpan.className = 'gwiazdki-wygranych';
    starySpan.style.display = 'none';
    nameplateEl.appendChild(starySpan);

    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'worker-bubble';
    bubbleEl.style.display = 'none';

    this.container.appendChild(nameplateEl);
    this.container.appendChild(bubbleEl);

    const connectorEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    connectorEl.setAttribute('class', 'worker-connector');
    connectorEl.style.opacity = '0';
    this.linesSvg.appendChild(connectorEl);

    const data = {
      workerIndex,
      nameplateEl,
      rankSpan,
      userSpan,
      starySpan,
      bubbleEl,
      connectorEl,
      timer: null,
      active: false,
      fainted: false, // stan omdlenia (boss.js) - musi przetrwac kazdy update z syncLeaderboardAndOverlays
      savedRank: '',
      lastUsername: null,
      // Biezace (wygladzone) pionowe przesuniecie plakietki wzgledem
      // naturalnej pozycji nad glowa - patrz updatePositions/_rozsunNaGrupy.
      // Trzymane MIEDZY klatkami (nie resetowane co wywolanie), zeby
      // przejscie do/z rozsuniecia bylo plynne, a nie skokowe.
      stackOffset: 0,
    };
    this.overlays.set(workerIndex, data);
    return data;
  }

  updateWorkerUser(workerIndex, userData) {
    const item = this._getOrCreate(workerIndex);
    if (!userData) {
      item.active = false;
      item.nameplateEl.style.display = 'none';
      item.bubbleEl.style.display = 'none';
      // Awatar zostal usuniety ze slotu (np. zabity przez bossa) - znacznik
      // omdlenia NIE moze zostac wiszacy, inaczej kolejny widz, ktory zajmie
      // ten slot, dostanie 💤 mimo ze wcale nie jest omdlaly.
      item.fainted = false;
      item.nameplateEl.classList.remove('worker-fainted');
      item.lastUsername = null;
      return;
    }
    // Nowy widz zajal ten slot (inny nick niz poprzednio) - stary znacznik
    // omdlenia nalezal do KOGO INNEGO i nie moze przetrwac na nowym wlascicielu slotu.
    const cleanUser = String(userData.username || '').toLowerCase();
    if (item.lastUsername !== null && item.lastUsername !== cleanUser) {
      item.fainted = false;
      item.nameplateEl.classList.remove('worker-fainted');
    }
    item.lastUsername = cleanUser;
    item.active = true;
    const rank = userData.rank;
    const rankLabel = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : (rank ? `#${rank}` : '');
    item.savedRank = rankLabel;
    item.userSpan.textContent = userData.username;
    item.userSpan.classList.toggle('nick-teczowy', !!userData.teczowyNick);
    item.userSpan.style.color = userData.teczowyNick ? '' : (userData.color || '#53fc18');
    const wygrane = userData.wygraneMinigry || 0;
    item.starySpan.textContent = wygrane > 0 ? `⭐${wygrane}` : '';
    item.starySpan.style.display = wygrane > 0 ? '' : 'none';
    item.nameplateEl.className = `worker-nameplate ${rank === 1 ? 'rank-1' : ''}`;
    // Kazdy sync rankingu (np. po zwyklym "kliku" z czatu) nadpisuje className
    // i tresc rankSpan - bez tego znacznik omdlenia (boss.js) gasnie po ulamku
    // sekundy przy zywym czacie. Odtwarzamy go na koniec, PO nadpisaniu.
    if (item.fainted) {
      item.nameplateEl.classList.add('worker-fainted');
      item.rankSpan.textContent = '💤';
    } else {
      item.rankSpan.textContent = rankLabel;
    }
  }

  /** Wlacza/wylacza wizualny znacznik omdlenia danego slotu (uzywane przez boss.js). */
  setFainted(workerIndex, fainted) {
    const item = this._getOrCreate(workerIndex);
    item.fainted = !!fainted;
    item.nameplateEl.classList.toggle('worker-fainted', item.fainted);
    item.rankSpan.textContent = item.fainted ? '💤' : item.savedRank;
  }

  showSpeechBubble(workerIndex, text) {
    if (!text) return;
    const clean = text.trim();
    if (!clean) return;

    const item = this._getOrCreate(workerIndex);
    item.bubbleEl.replaceChildren(...wezlyZTrescia(clean, { maxEmotek: 3 }));
    item.bubbleEl.style.display = 'block';
    item.bubbleEl.classList.add('active');

    if (item.timer) clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      item.bubbleEl.classList.remove('active');
    }, 6000);
  }

  // Przyblizona polowa szerokosci/wysokosci plakietki na ekranie - nick ma
  // zmienna dlugosc (flex + padding, patrz .worker-nameplate w style.css), ale
  // stala aproksymacja wystarcza do wykrycia "prawdziwego" nakladania sie na
  // ekranie (wymaganie: grupowac po realnym nakladaniu, nie po wspolnym polu
  // siatki, bo postacie z SASIEDNICH pol tez moga sie nalozyc z daleka) i,
  // w odroznieniu od pomiaru getBoundingClientRect co klatke, jest calkowicie
  // stabilna - zero migotania przy zmianie dlugosci nicku miedzy klatkami.
  static _POLOWA_SZEROKOSCI_PLAKIETKI = 60;
  static _POLOWA_WYSOKOSCI_PLAKIETKI = 13;
  static _ODSTEP_STOSU = 24; // odleglosc miedzy kolejnymi plakietkami w stosie (px)

  updatePositions(workerEntries, camera, canvasRect) {
    const aktywne = [];

    for (const entry of workerEntries) {
      if (!entry.obj) continue;
      const item = this.overlays.get(entry.typeIndex);
      if (!item || !item.active) continue;

      // Głowa postaci w 3D (wysokość ~0.82)
      entry.obj.getWorldPosition(this._headWorld);
      this._headWorld.y += 0.82;

      this._projected.copy(this._headWorld).project(camera);

      // Jeśli za kamerą (z >= 1), ukryj
      if (this._projected.z >= 1.0) {
        item.nameplateEl.style.display = 'none';
        item.bubbleEl.style.display = 'none';
        item.connectorEl.style.opacity = '0';
        continue;
      }

      const sx = canvasRect.left + (this._projected.x * 0.5 + 0.5) * canvasRect.width;
      const sy = canvasRect.top + (-this._projected.y * 0.5 + 0.5) * canvasRect.height;
      const zIndex = Math.max(1, Math.round((1.0 - this._projected.z) * 100)) + 10;

      item.nameplateEl.style.display = 'flex';
      aktywne.push({ item, sx, sy, zIndex, typeIndex: entry.typeIndex });
    }

    this._rozsunNaGrupy(aktywne);

    for (const w of aktywne) {
      const { item, sx, sy, zIndex } = w;
      const top = sy - 6 + item.stackOffset;

      item.nameplateEl.style.left = `${sx}px`;
      item.nameplateEl.style.top = `${top}px`;
      item.nameplateEl.style.zIndex = zIndex;

      item.bubbleEl.style.left = `${sx}px`;
      item.bubbleEl.style.top = `${top - 28}px`;
      item.bubbleEl.style.zIndex = zIndex + 5;

      // Lacznik widoczny TYLKO gdy plakietka faktycznie zostala odsunieta od
      // naturalnej pozycji nad glowa - dla pojedynczych postaci (bez nikogo
      // w poblizu na ekranie) nie ma czego wskazywac, plakietka i tak jest
      // dokladnie nad glowa jak wczesniej.
      if (Math.abs(item.stackOffset) > 2) {
        item.connectorEl.setAttribute('x1', String(sx));
        item.connectorEl.setAttribute('y1', String(top));
        item.connectorEl.setAttribute('x2', String(sx));
        item.connectorEl.setAttribute('y2', String(sy));
        item.connectorEl.style.opacity = '0.85';
      } else {
        item.connectorEl.style.opacity = '0';
      }
    }
  }

  /**
   * Grupuje plakietki, ktorych ekranowe prostokaty (aproksymowane stalym
   * rozmiarem, patrz stale wyzej) faktycznie sie nakladaja - NIE po wspolnym
   * polu siatki 3D, bo dwie postacie na SASIEDNICH polach moga tez nalozyc
   * sie na ekranie z daleka (kamera perspektywiczna), a dwie na tym samym
   * polu moga NIE nakladac sie wcale, gdy kamera jest bardzo blisko. W
   * kazdej grupie >= 2 elementow plakietki ida w PIONOWY STOS (kolejna nad
   * poprzednia, o stala odleglosc _ODSTEP_STOSU), zaczynajac od naturalnie
   * najwyzej polozonej glowy w grupie.
   *
   * Kolejnosc w stosie jest stabilna miedzy klatkami (sortowanie po
   * typeIndex - NIE po biezacej pozycji na ekranie, ktora drga klatka po
   * klatce) - bez tego dwie plakietki potrafilyby zamieniac sie miejscami z
   * klatki na klatke (migotanie). Docelowe przesuniecie jest tylko CELEM -
   * faktyczne item.stackOffset dochodzi do niego plynnie (wygladzanie w dole
   * tej funkcji), zeby wejscie/wyjscie z grupy (np. gdy ktos wchodzi na pole)
   * nie bylo skokowe.
   */
  _rozsunNaGrupy(aktywne) {
    const n = aktywne.length;
    if (n === 0) return;

    aktywne.sort((a, b) => a.typeIndex - b.typeIndex);

    const parent = aktywne.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    const progW = WorkerOverlayManager._POLOWA_SZEROKOSCI_PLAKIETKI * 2;
    const progH = WorkerOverlayManager._POLOWA_WYSOKOSCI_PLAKIETKI * 2;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = Math.abs(aktywne[i].sx - aktywne[j].sx);
        const dy = Math.abs(aktywne[i].sy - aktywne[j].sy);
        if (dx < progW && dy < progH) union(i, j);
      }
    }

    const grupy = new Map();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!grupy.has(root)) grupy.set(root, []);
      grupy.get(root).push(aktywne[i]);
    }

    const STEP = WorkerOverlayManager._ODSTEP_STOSU;
    for (const grupa of grupy.values()) {
      if (grupa.length < 2) {
        grupa[0]._celOffset = 0;
        continue;
      }
      // grupa dziedziczy stabilna kolejnosc po typeIndex z sortowania aktywne[] wyzej
      const najwyzsze = Math.min(...grupa.map((g) => g.sy));
      grupa.forEach((g, idx) => {
        g._celOffset = (najwyzsze - g.sy) - idx * STEP;
      });
    }

    for (const w of aktywne) {
      if (w.item.stackOffset === undefined) w.item.stackOffset = w._celOffset;
      // Wygladzenie wykladnicze, niezalezne od dt (jak reszta drobnej
      // kosmetyki w tym projekcie, np. pulsowanie markerow minigier) - w
      // ~60 kl/s daje plynne, ale szybkie (kilka klatek) dojscie do celu.
      w.item.stackOffset += (w._celOffset - w.item.stackOffset) * 0.28;
    }
  }

  clear() {
    for (const item of this.overlays.values()) {
      item.nameplateEl.remove();
      item.bubbleEl.remove();
      item.connectorEl.remove();
    }
    this.overlays.clear();
  }
}

const MAX_BOSS_FEED_ITEMS = 4;
const DEFAULT_BOSS_FEED_DURATION = 6500;

/**
 * Wyświetla eleganckie powiadomienie o zdarzeniach walki z bossem
 * po prawej stronie ekranu. Nowe wpisy pojawiają się na dole.
 * Limituje liczbę powiadomień do 4, aby uniknąć cluttera.
 */
export function showBossNotification(type, title, bodyText, durationMs = DEFAULT_BOSS_FEED_DURATION) {
  let feed = document.getElementById('boss-feed');
  if (!feed) {
    feed = document.createElement('div');
    feed.id = 'boss-feed';
    feed.className = 'boss-feed';
    document.body.appendChild(feed);
  }

  // Ograniczenie cluttera: maksymalnie MAX_BOSS_FEED_ITEMS widocznych powiadomień
  while (feed.children.length >= MAX_BOSS_FEED_ITEMS) {
    const oldest = feed.firstElementChild;
    if (oldest) {
      if (oldest._dismissTimer) clearTimeout(oldest._dismissTimer);
      oldest.remove();
    }
  }

  const item = document.createElement('div');
  item.className = `boss-feed-item type-${type}`;
  item.innerHTML = `
    <div class="boss-feed-title">${title}</div>
    <div class="boss-feed-body">${bodyText}</div>
  `;

  feed.appendChild(item);

  // Wymuszenie reflow i animacja wejścia z prawej strony
  void item.offsetWidth;
  item.classList.add('show');

  item._dismissTimer = setTimeout(() => {
    item.classList.remove('show');
    item.classList.add('fade-out');
    setTimeout(() => {
      if (item.parentNode === feed) {
        item.remove();
      }
    }, 320);
  }, durationMs);
}
