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
    document.querySelectorAll('#leaderboard-panel, #kick-panel, #kick-embed-panel').forEach((el) => {
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

  // Dostosowanie pozycji przy zmianie rozmiaru okna przeglądarki
  window.addEventListener('resize', () => {
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
    if (msg.isKlik) div.classList.add('kick-msg-klik');

    if (msg.isKlik) {
      const tag = document.createElement('span');
      tag.className = 'kick-tag-klik';
      tag.textContent = 'KLIK';
      div.appendChild(tag);
    }

    const userSpan = document.createElement('span');
    userSpan.className = 'user';
    userSpan.style.color = msg.color || '#53fc18';
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
const KICK_EMBED_COLLAPSED_KEY = 'bankomat-clicker-kick-embed-collapsed';

/**
 * Wbudowany, PISZACY czat Kicka (oficjalny popout w iframe) - w odroznieniu
 * od #kick-panel (KickUI wyzej), ktory jest tylko-do-odczytu i pokazuje
 * wiadomosci wciagniete do gry. Ten panel pozwala widzowi pisac na czacie
 * bez przelaczania sie na kick.com.
 *
 * Iframe jest CROSS-ORIGIN (kick.com), wiec nie da sie odczytac ani ruszyc
 * jego zawartosci z JS - i nie trzeba, to tylko osadzenie oficjalnego popoutu.
 *
 * src ustawiamy DOPIERO przy pierwszym rozwinieciu panelu (leniwe ladowanie) -
 * czat Kicka ciagnie wlasny websocket i zasoby, a strona rownolegle startuje
 * scene Three.js i wlasne polaczenie z czatem (kick.js). Ktos, kto nigdy nie
 * otworzy panelu, nie powinien tego pobierac. Po pierwszym ustawieniu src juz
 * go nie zerujemy przy zwijaniu - przeladowywanie czatu za kazdym zwinieciem
 * byloby gorsze niz zostawienie go zaladowanego w tle.
 */
export class KickEmbedUI {
  constructor() {
    this.panel = document.getElementById('kick-embed-panel');
    this.header = document.getElementById('kick-embed-header');
    this.frame = document.getElementById('kick-embed-frame');
    this.toggleBtn = document.getElementById('kick-embed-toggle-btn');

    this._loaded = false;

    this._restoreCollapsedState();
    this._bindEvents();

    if (this.panel && this.header) {
      makeDraggable(this.panel, this.header, 'bankomat-clicker-kick-embed-pos');
    }
  }

  _restoreCollapsedState() {
    if (!this.panel || !this.toggleBtn) return;
    let collapsed = true; // domyslnie zwiniety - patrz uzasadnienie w opisie klasy
    try {
      const saved = localStorage.getItem(KICK_EMBED_COLLAPSED_KEY);
      if (saved !== null) collapsed = saved === '1';
    } catch (_) {}

    this.panel.classList.toggle('collapsed', collapsed);
    this.toggleBtn.textContent = collapsed ? '+' : '–';

    if (!collapsed) this._ensureLoaded();
  }

  _bindEvents() {
    if (!this.toggleBtn || !this.panel) return;
    this.toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = this.panel.classList.toggle('collapsed');
      this.toggleBtn.textContent = collapsed ? '+' : '–';

      try {
        localStorage.setItem(KICK_EMBED_COLLAPSED_KEY, collapsed ? '1' : '0');
      } catch (_) {}

      if (!collapsed) this._ensureLoaded();
    });
  }

  _ensureLoaded() {
    if (this._loaded || !this.frame) return;
    this._loaded = true;
    this.frame.src = KICK_EMBED_SRC;
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
      empty.innerHTML = 'Napisz <b>klik</b> na czacie Kicka,<br>aby zająć 1. miejsce w rankingu!';
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
      nickSpan.style.color = user.color || '#53fc18';
      nickSpan.textContent = user.username;
      left.appendChild(nickSpan);

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

    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'worker-bubble';
    bubbleEl.style.display = 'none';

    this.container.appendChild(nameplateEl);
    this.container.appendChild(bubbleEl);

    const data = {
      workerIndex,
      nameplateEl,
      rankSpan,
      userSpan,
      bubbleEl,
      timer: null,
      active: false,
      fainted: false, // stan omdlenia (boss.js) - musi przetrwac kazdy update z syncLeaderboardAndOverlays
      savedRank: '',
      lastUsername: null,
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
    item.userSpan.style.color = userData.color || '#53fc18';
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
    // Nigdy nie wyświetlaj słowa "klik" ani wariantów nad głowami postaci
    const clean = text
      .replace(/(?:^|\s)[!/]*klik+[!.,?*~]*(?=\s|$)/gi, '')
      .replace(/(?:^|\s)[!/]*click+[!.,?*~]*(?=\s|$)/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
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

  updatePositions(workerEntries, camera, canvasRect) {
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
        continue;
      }

      const sx = canvasRect.left + (this._projected.x * 0.5 + 0.5) * canvasRect.width;
      const sy = canvasRect.top + (-this._projected.y * 0.5 + 0.5) * canvasRect.height;

      const zIndex = Math.max(1, Math.round((1.0 - this._projected.z) * 100)) + 10;

      item.nameplateEl.style.display = 'flex';
      item.nameplateEl.style.left = `${sx}px`;
      item.nameplateEl.style.top = `${sy - 6}px`;
      item.nameplateEl.style.zIndex = zIndex;

      item.bubbleEl.style.left = `${sx}px`;
      item.bubbleEl.style.top = `${sy - 34}px`;
      item.bubbleEl.style.zIndex = zIndex + 5;
    }
  }

  clear() {
    for (const item of this.overlays.values()) {
      item.nameplateEl.remove();
      item.bubbleEl.remove();
    }
    this.overlays.clear();
  }
}

/**
 * Panel z logiem zdarzen Vanessy. Pokazuje na zywo co robi zlodziejka -
 * kogo okrada, ile zabrala na kazdym tyku, kto ja przegonil i ile
 * z lupu wrocilo do gry. Wpisy dopisywane sa pojedynczo (bez przebudowy
 * calej listy), a najnowszy jest na gorze dzieki column-reverse w CSS.
 */
export class VanessaLogUI {
  constructor(vanessa) {
    this.vanessa = vanessa;
    this.panel = document.getElementById('vanessa-log-panel');
    this.header = document.getElementById('vanessa-log-header');
    this.listEl = document.getElementById('vanessa-log-list');
    this.toggleBtn = document.getElementById('vanessa-log-toggle-btn');
    this.clearBtn = document.getElementById('vanessa-log-clear-btn');
    this.maxRows = 200;

    if (this.toggleBtn && this.panel) {
      this.toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.panel.classList.toggle('collapsed');
        this.toggleBtn.textContent = this.panel.classList.contains('collapsed') ? '+' : '–';
      });
      this.toggleBtn.textContent = this.panel.classList.contains('collapsed') ? '+' : '–';
    }

    if (this.clearBtn) {
      this.clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.vanessa) this.vanessa.clearLog();
        else this.renderAll([]);
      });
    }

    if (this.panel && this.header) {
      makeDraggable(this.panel, this.header, 'bankomat-clicker-vanessa-log-pos');
    }

    this.renderAll(vanessa ? vanessa.getLog(this.maxRows) : []);
  }

  _rowFor(entry) {
    const row = document.createElement('div');
    row.className = `vlog-row vlog-${entry.kind || 'info'}`;

    const time = document.createElement('span');
    time.className = 'vlog-time';
    time.textContent = new Date(entry.t).toLocaleTimeString('pl-PL');
    row.appendChild(time);

    const run = document.createElement('span');
    run.className = 'vlog-run';
    run.textContent = `#${entry.run}`;
    row.appendChild(run);

    const msg = document.createElement('span');
    msg.className = 'vlog-msg';
    msg.textContent = entry.message;
    if (entry.data) {
      const extra = document.createElement('span');
      extra.className = 'vlog-data';
      extra.textContent = ` ${JSON.stringify(entry.data)}`;
      msg.appendChild(extra);
    }
    row.appendChild(msg);

    return row;
  }

  append(entry) {
    if (!this.listEl || !entry) return;
    const empty = this.listEl.querySelector('#vanessa-log-empty');
    if (empty) empty.remove();

    this.listEl.appendChild(this._rowFor(entry));
    // column-reverse: najstarsze wpisy sa na koncu listy w DOM
    while (this.listEl.children.length > this.maxRows) {
      this.listEl.removeChild(this.listEl.firstElementChild);
    }
  }

  renderAll(entries) {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    if (!entries || entries.length === 0) {
      const empty = document.createElement('div');
      empty.id = 'vanessa-log-empty';
      empty.textContent = 'Brak zdarzeń. Vanessa jeszcze się nie pojawiła.';
      this.listEl.appendChild(empty);
      return;
    }
    for (const e of entries) this.listEl.appendChild(this._rowFor(e));
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
