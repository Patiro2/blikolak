import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { loadArcade } from './assets.js';
import { fmtShort } from './format.js';
import { audio } from './audio.js';

const SPAWN_MIN = 35; // sekundy do kolejnego pojawienia się
const SPAWN_MAX = 70;
const MODEL_KEY = 'character-female-e';

// Parametry tykania kradziezy - co ile sekund i jaki ulamek dorobku ofiary
const STEAL_TICK_INTERVAL = 0.8;
const STEAL_TICK_FRACTION = 0.05; // ok. 5% aktualnego dorobku ofiary na tyk
const STEAL_TICK_MIN = 1; // minimalna kwota (zl) kradziona na tyk, jesli ofiara ma z czego

// Ile wpisow logu zdarzen trzymamy w pamieci (bufor cykliczny).
const LOG_LIMIT = 300;

export const VANESSA_WORDS = [
  'STOP',
  'WON',
  'POLICJA',
  'ALARM',
  'ZŁODZIEJ',
  'STRAŻ',
  'ŁAPAĆ',
  'UCIEKAJ',
  'ODDAJ',
  'KASJER',
  'SPADAJ',
  'RĘCE',
  'ARESZT',
  'PILNUJ',
  'RATUNKU',
  'HAŁAS',
  'BIEGNIJ',
  'POMOCY',
  'WYSKOK',
  'DRAKA',
];

export function normalizePolish(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/ą/g, 'a')
    .replace(/ć/g, 'c')
    .replace(/ę/g, 'e')
    .replace(/ł/g, 'l')
    .replace(/ń/g, 'n')
    .replace(/ó/g, 'o')
    .replace(/ś/g, 's')
    .replace(/ź/g, 'z')
    .replace(/ż/g, 'z')
    .replace(/[^a-z0-9]/g, ' ')
    .trim();
}

export function showTopAnnouncement(title, bodyText, durationMs = 2800) {
  let el = document.getElementById('top-announcement');
  if (!el) {
    el = document.createElement('div');
    el.id = 'top-announcement';
    el.className = 'top-announcement';
    document.body.appendChild(el);
  }

  el.innerHTML = `
    <div class="announcement-title">${title}</div>
    <div class="announcement-body">${bodyText}</div>
  `;

  // Wymuszenie reflow i płynne pojawienie się
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');

  if (el._timer) clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.classList.remove('show');
  }, durationMs);
}

const CORNERS = [
  { x: -2.8, z: -2.8 }, // lewy tył
  { x: 2.8, z: -2.8 },  // prawy tył
  { x: -2.8, z: 2.4 },  // lewy przód
  { x: 2.8, z: 2.4 },   // prawy przód
];

const TARGET_ATM = { x: 0.18, z: 0.72 }; // pozycja tuż przed ekranem bankomatu

const STEAL_TAUNTS = [
  'Haha! Cała ta forsa jest moja! 😈',
  'Pakuję hajs do wora! 💰',
  'Dawać wszystko! Hehe! 💸',
  'Czat milczy, więc kradnę dalej! 🤑',
];

const ESCAPE_TAUNTS = [
  'Udało się! Nara frajerzy! 🏃‍♀️💨',
  'Dzięki za darmowy hajs! 👋',
  'Do widzenia, frajerzy! 💰',
];

const FLEE_TAUNTS = [
  'Auuuć! Zostaw mnie! 🏃‍♀️💨',
  'Złapali mnie! Uciekam! 😱',
  'Już oddaję, nie bij! 😭',
];

export class VanessaManager {
  constructor(scene, camera, machine, economy, coinPool, projectAndFloat, onRewardViewer) {
    this.scene = scene;
    this.camera = camera;
    this.machine = machine;
    this.economy = economy;
    this.coinPool = coinPool;
    this.projectAndFloat = projectAndFloat;
    this.onRewardViewer = onRewardViewer || null;

    this.template = null;
    this.animations = null;
    this.model = null;
    this.mixer = null;

    this.actions = {};
    this.currentAction = null;

    // FSM: 'IDLE' | 'SNEAKING' | 'STEALING' | 'ESCAPING' | 'FLEEING'
    this.state = 'IDLE';

    this.paused = false; // ustawiane z main.js, gdy boss.isActive() - blokuje nowy spawn Vanessy

    this.spawnTimer = this._randomSpawnDelay();
    this.stealTimer = 0;
    this.stealTickAcc = 0;
    this.totalStolen = 0; // suma skradzionych zl w biezacym wystapieniu
    this.secretWord = null;
    this.victim = null;
    this.victimWorkerPos = null;
    this.workerManager = null;
    this.kickChat = null;

    this.spawnPos = new THREE.Vector3();
    this.targetPos = new THREE.Vector3(TARGET_ATM.x, 0, TARGET_ATM.z);
    this.exitPos = new THREE.Vector3();

    this.speed = 1.2;

    this.container = document.getElementById('worker-overlays') || document.body;
    this.nameplateEl = null;
    this.secretTagEl = null;
    this.bubbleEl = null;
    this._bubbleTimer = null;

    this._headWorld = new THREE.Vector3();
    this._projected = new THREE.Vector3();

    // --- Logi zdarzen ---
    // Bufor cykliczny ostatnich zdarzen. Pozwala podejrzec co dokladnie robila
    // Vanessa (kogo okradla, ile zabrala, kto ja przegonil i ile wrocilo do gry)
    // bez wpatrywania sie w konsole w trakcie gry.
    this.logEntries = [];
    this.onLog = null; // ustawiane z main.js, zeby panel na ekranie mogl sie odswiezac
    this.logToConsole = true;
    this._runId = 0; // numer kolejnego "napadu", ulatwia czytanie logu

    this._createDOMOverlays();
  }

  /**
   * Zapisuje zdarzenie do bufora, konsoli i (jesli podpiety) panelu na ekranie.
   * `kind` steruje kolorem wpisu w panelu: info | spawn | steal | good | bad.
   */
  _log(kind, message, data = null) {
    const entry = {
      t: Date.now(),
      run: this._runId,
      kind,
      message,
      data,
      state: this.state,
    };
    this.logEntries.push(entry);
    if (this.logEntries.length > LOG_LIMIT) {
      this.logEntries.splice(0, this.logEntries.length - LOG_LIMIT);
    }
    if (this.logToConsole) {
      const stamp = new Date(entry.t).toLocaleTimeString('pl-PL');
      if (data) {
        console.log(`[Vanessa #${entry.run} ${stamp}] ${message}`, data);
      } else {
        console.log(`[Vanessa #${entry.run} ${stamp}] ${message}`);
      }
    }
    if (this.onLog) {
      try {
        this.onLog(entry);
      } catch (err) {
        console.error('[Vanessa] Blad w obsludze logu:', err);
      }
    }
  }

  /**
   * Zwraca czy dany gracz jest w tym momencie okradany przez Vanessę (stan STEALING).
   * Dopiero w trakcie kradzieży gracz zostaje zablokowany i nie może się ruszać.
   */
  isStealingFrom(username) {
    if (this.state !== 'STEALING' || !this.victim || !this.victim.username) return false;
    return this.victim.username.toLowerCase() === (username || '').toLowerCase();
  }

  /**
   * Zwraca czy dany slot pracownika jest w tym momencie unieruchomiony przez Vanessę.
   */
  isWorkerRobbed(workerIndex) {
    if (this.state !== 'STEALING' || !this.victim) return false;
    return this.victim.workerIndex === workerIndex;
  }

  _setVictimRobbed() {
    if (this.victim && this.workerManager && this.victim.workerIndex !== null) {
      const entry = this.workerManager.getWorkerType(this.victim.workerIndex);
      if (entry) {
        entry.isRobbed = true;
      }
    }
  }

  _clearVictimRobbed() {
    if (this.victim && this.workerManager && this.victim.workerIndex !== null) {
      const entry = this.workerManager.getWorkerType(this.victim.workerIndex);
      if (entry) {
        entry.isRobbed = false;
      }
    }
  }

  /** Zmiana stanu automatu skonczonego z wpisem do logu. */
  _setState(next, reason) {
    const prev = this.state;
    if (prev === next) return;
    if (prev === 'STEALING' && next !== 'STEALING') {
      this._clearVictimRobbed();
    }
    this.state = next;
    this._log('info', `Stan: ${prev} → ${next}${reason ? ` (${reason})` : ''}`);
  }

  /** Ostatnie wpisy logu - wygodne do odczytu z konsoli przegladarki. */
  getLog(limit = 50) {
    return this.logEntries.slice(-limit);
  }

  /** Czytelny podglad logu w konsoli jako tabela. */
  printLog(limit = 50) {
    console.table(this.getLog(limit).map((e) => ({
      czas: new Date(e.t).toLocaleTimeString('pl-PL'),
      napad: e.run,
      typ: e.kind,
      zdarzenie: e.message,
    })));
  }

  clearLog() {
    this.logEntries = [];
    if (this.onLog) this.onLog(null);
  }

  _randomSpawnDelay() {
    return SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
  }

  _createDOMOverlays() {
    // 1. Plakietka z imieniem Vanessa i hasłem nad głową
    const np = document.createElement('div');
    np.className = 'vanessa-nameplate';
    np.style.display = 'none';
    np.title = 'Kliknij Vanessę lub wpisz jej hasło na czacie, aby ją przegonić!';

    const badge = document.createElement('span');
    badge.className = 'vanessa-badge';
    badge.textContent = '🦹‍♀️';

    const nick = document.createElement('span');
    nick.className = 'vanessa-nick';
    nick.textContent = 'Vanessa';

    const secretTag = document.createElement('span');
    secretTag.className = 'vanessa-secret-tag';
    secretTag.innerHTML = 'HASŁO: <strong class="vanessa-word">STOP</strong>';

    const hint = document.createElement('span');
    hint.className = 'vanessa-hint';
    hint.textContent = 'KLIKNIJ!';

    np.appendChild(badge);
    np.appendChild(nick);
    np.appendChild(secretTag);
    np.appendChild(hint);

    // Kliknięcie w plakietkę również przegania Vanessę
    np.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.chaseAway();
    });

    // 2. Dymek wypowiedzi
    const bubble = document.createElement('div');
    bubble.className = 'vanessa-bubble';
    bubble.style.display = 'none';

    bubble.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.chaseAway();
    });

    this.container.appendChild(np);
    this.container.appendChild(bubble);

    this.nameplateEl = np;
    this.secretTagEl = secretTag;
    this.bubbleEl = bubble;
  }

  async init() {
    const gltf = await loadArcade(MODEL_KEY);
    this.template = gltf.scene;
    this.animations = gltf.animations || [];
  }

  showBubble(text, durationMs = 3500) {
    if (!this.bubbleEl) return;
    this.bubbleEl.textContent = text;
    this.bubbleEl.style.display = 'block';
    this.bubbleEl.classList.add('active');

    if (this._bubbleTimer) clearTimeout(this._bubbleTimer);
    this._bubbleTimer = setTimeout(() => {
      if (this.bubbleEl) {
        this.bubbleEl.classList.remove('active');
        this.bubbleEl.style.display = 'none';
      }
    }, durationMs);
  }

  playAction(name) {
    const clip = THREE.AnimationClip.findByName(this.animations, name);
    if (!clip || !this.mixer) return;

    const next = this.mixer.clipAction(clip);
    if (this.currentAction === next) return;

    if (this.currentAction) {
      this.currentAction.crossFadeTo(next, 0.2, false);
    }
    next.reset().play();
    this.currentAction = next;
  }

  setContext({ workerManager, kickChat }) {
    this.workerManager = workerManager;
    this.kickChat = kickChat;
  }

  /**
   * Ręczne lub losowe wywołanie pojawienia się Vanessy w scenie.
   */
  spawn(force = false) {
    if (this.model) {
      if (!force) return;
      this.despawn();
    }
    if (!this.template) {
      this._log('bad', 'Nie pojawia sie: model Vanessy nie jest jeszcze zaladowany');
      return;
    }

    this._runId += 1;

    // Losowe krótkie polskie słowo - hasło do odstraszenia
    this.secretWord = VANESSA_WORDS[Math.floor(Math.random() * VANESSA_WORDS.length)];

    if (this.secretTagEl) {
      this.secretTagEl.innerHTML = `HASŁO: <strong class="vanessa-word">${this.secretWord}</strong>`;
    }

    // Wybór losowego gracza z TOP 10 jako ofiary kradzieży zl (nie kliknięć!)
    // Vanessa okrada tylko widzow z dodatnim dorobkiem - jesli nie ma kogo
    // okrasc, w ogole sie nie pojawia (patrz ponizej).
    let chosenVictim = null;
    let chosenTargetPos = new THREE.Vector3(TARGET_ATM.x, 0, TARGET_ATM.z);
    this.victimWorkerPos = null;

    if (this.kickChat) {
      const top10 = this.kickChat.getTopEarners(10).filter((u) => (u.totalEarned || 0) > 0);
      if (top10.length > 0) {
        const randPlayer = top10[Math.floor(Math.random() * top10.length)];
        const workerIndex = this.kickChat.getWorkerForUser(randPlayer.username);
        let workerObj = null;
        if (workerIndex !== null && this.workerManager) {
          const entry = this.workerManager.getWorkerType(workerIndex);
          if (entry && entry.obj) {
            workerObj = entry.obj;
          }
        }

        chosenVictim = {
          username: randPlayer.username,
          color: randPlayer.color || '#53fc18',
          workerIndex,
        };

        if (workerObj) {
          this.victimWorkerPos = workerObj.position.clone();
          const wp = workerObj.position;
          const distToCenter = Math.hypot(wp.x, wp.z);
          if (distToCenter > 0.1) {
            const factor = Math.max(0.2, (distToCenter - 0.38) / distToCenter);
            chosenTargetPos.set(wp.x * factor, 0, wp.z * factor);
          } else {
            chosenTargetPos.copy(wp);
          }
        }
      }
    }

    if (!chosenVictim) {
      // Nikt w Top 10 nie ma z czego kraść - Vanessa nie ma po co sie pojawiac.
      // Probujemy ponownie po kolejnym losowym odstepie czasu.
      this._log('info', 'Nie pojawia sie: nikt w Top 10 nie ma dodatniego dorobku', {
        wTop10: this.kickChat ? this.kickChat.getTopEarners(10).length : 0,
      });
      this.spawnTimer = this._randomSpawnDelay();
      return;
    }

    this.victim = chosenVictim;
    this.targetPos.copy(chosenTargetPos);
    this.totalStolen = 0;

    if (this.nameplateEl) {
      this.nameplateEl.title = `Vanessa okrada @${this.victim.username} ze złotówek! Wpisz hasło "${this.secretWord}" lub kliknij na nią!`;
    }

    // Wybór losowego narożnika areny
    const corner = CORNERS[Math.floor(Math.random() * CORNERS.length)];
    this.spawnPos.set(corner.x, 0, corner.z);
    this.exitPos.set(corner.x, 0, corner.z);

    const obj = SkeletonUtils.clone(this.template);
    obj.userData = { isVanessa: true };
    obj.position.copy(this.spawnPos);

    // Obrót w kierunku celu
    obj.lookAt(this.targetPos.x, 0, this.targetPos.z);

    obj.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        // Złodziejski fioletowo-karminowy odcień
        if (child.material) {
          const mat = child.material.clone();
          mat.emissive = new THREE.Color(0x350012);
          child.material = mat;
        }
      }
    });

    this.scene.add(obj);
    this.model = obj;

    this.mixer = new THREE.AnimationMixer(obj);
    this.currentAction = null;
    this.playAction('walk');

    this.speed = 1.25;
    this.state = 'SNEAKING';
    this.stealTimer = 0;
    this.stealTickAcc = 0;
    this.totalStolen = 0;

    const dorobekOfiary = this.kickChat && this.victim
      ? (this.kickChat.leaderboard[this.victim.username.toLowerCase()] || {}).totalEarned || 0
      : 0;
    this._log('spawn', `Pojawila sie i skrada sie do @${this.victim.username}`, {
      ofiara: this.victim.username,
      dorobekOfiary: Math.round(dorobekOfiary),
      haslo: this.secretWord,
      startXZ: [ +this.model.position.x.toFixed(2), +this.model.position.z.toFixed(2) ],
      celXZ: [ +this.targetPos.x.toFixed(2), +this.targetPos.z.toFixed(2) ],
    });

    // Rejestracja klikalności w Machine (Raycaster)
    this.machine.registerClickable(this.model, (point) => {
      this.chaseAway(point);
    });

    audio.play('vanessa-spawn');
    this.nameplateEl.style.display = 'flex';
    this.showBubble(`Ciiicho... idę okraść @${this.victim.username} ze złotówek! 😈`, 3500);
  }

  /**
   * Sprawdza wiadomość z czatu Kick. Jeśli zawiera sekretne słowo Vanessy,
   * Vanessa zostaje natychmiast przepędzona przez tego widza.
   */
  checkChatWord(content, username, color) {
    if (this.state === 'IDLE' || this.state === 'FLEEING' || !this.secretWord) {
      return false;
    }
    if (!content) return false;

    const normContent = normalizePolish(content);
    const normWord = normalizePolish(this.secretWord);

    const tokens = normContent.split(/\s+/).filter(Boolean);
    const matched = tokens.some((t) => {
      if (t === normWord) return true;
      if (normWord.length >= 4 && t.startsWith(normWord) && t.length - normWord.length <= 2) {
        return true;
      }
      return false;
    });

    if (matched) {
      this._log('good', `@${username} trafil haslo "${this.secretWord}" na czacie`, {
        wiadomosc: content,
      });
      this.chaseAwayByViewer(username, this.secretWord, color);
      return true;
    }
    return false;
  }

  /**
   * Przepędzenie Vanessy przez widza z czatu Kick po wpisaniu sekretnego słowa.
   */
  chaseAwayByViewer(username, word, color) {
    if (this.state === 'IDLE' || this.state === 'FLEEING') {
      this._log('info', `@${username} probowal przegonic Vanesse, ale stan to ${this.state}`);
      return;
    }

    this._setState('FLEEING', `przegoniona przez @${username}`);
    audio.play('vanessa-przegoniona');
    this.speed = 3.4; // szybki sprint ucieczki w panice!
    this.playAction('sprint');

    const stolen = this.totalStolen;
    // Nagroda: zawsze 10 zł, chyba że połowa ukradzionej kwoty jest większa niż 10 zł (wtedy połowa ukradzionej kwoty)
    const halfStolen = Math.floor(stolen * 0.5);
    const bounty = halfStolen > 10 ? halfStolen : 10;

    // Nagroda trafia na konto widza, który wykrzyczał hasło
    if (this.onRewardViewer) {
      this.onRewardViewer(username, bounty, color);
    }

    this._log('good', `Przegoniona przez widza @${username} - nagroda ${bounty} zl`, {
      przegonil: username,
      haslo: word,
      ukradlaLacznie: Math.round(stolen),
      nagroda: bounty,
      polowaWiekszaNiz10: halfStolen > 10,
      trafiloDo: `ranking: @${username}`,
      ofiara: this.victim ? this.victim.username : null,
    });

    const bountyText = `+${fmtShort(bounty)} zł dla @${username}! (krzyknął "${word}"!)`;
    this.projectAndFloat(
      this.model.position,
      bountyText,
      { crit: true, gold: true, kick: true }
    );

    // Dłuższy komunikat na górze środkowej części ekranu (2-3 sekundy)
    const bannerTitle = `🦹‍♀️ PRZEPĘDZONO ZŁODZIEJKĘ VANESSĘ!`;
    let bannerBody = `Widz <strong class="announcement-hero" style="color:${color || '#00f0ff'}">@${username}</strong> wykrzyczał hasło <strong>"${word}"</strong> i zdobywa <strong>${fmtShort(bounty)} zł</strong>!`;
    if (this.victim && stolen > 0) {
      if (halfStolen > 10) {
        bannerBody += `<br><span class="announcement-sub">@${username} odzyskał 50% skradzionej kwoty (+${fmtShort(bounty)} zł z ${fmtShort(stolen)} zł ukradzionych od <strong class="announcement-victim">@${this.victim.username}</strong>)! Reszta przepadła z Vanessą.</span>`;
      } else {
        bannerBody += `<br><span class="announcement-sub">Vanessa ukradła łącznie ${fmtShort(stolen)} zł od <strong class="announcement-victim">@${this.victim.username}</strong> zanim została przegoniona.</span>`;
      }
    }
    showTopAnnouncement(bannerTitle, bannerBody, 2800);

    const escapeWords = halfStolen > 10
      ? [
          `Aaa! Oddaję połowę (+${fmtShort(bounty)} zł), reszta moja! 😭🏃‍♀️💨`,
          `Skąd @${username} znał hasło "${word}"?! Uciekam z resztą hajsu! 😱🏃‍♀️💨`,
        ]
      : [
          `Aaa! @${username} krzyknął "${word}"! Zwiewam! 😱🏃‍♀️💨`,
          `Skąd @${username} znał hasło "${word}"?! Uciekam! 😭🏃‍♀️💨`,
          `O nie, "${word}"! Zdemaskowana przez @${username}! 🏃‍♀️💨`,
        ];
    this.showBubble(escapeWords[Math.floor(Math.random() * escapeWords.length)], 4000);

    if (this.secretTagEl) {
      this.secretTagEl.innerHTML = `Przepędził: <strong class="vanessa-word" style="color:${color || '#53fc18'}">@${username} (+${fmtShort(bounty)} zł)</strong>`;
    }

    this.model.lookAt(this.exitPos.x, 0, this.exitPos.z);
  }

  /**
   * Przegonienie Vanessy po kliknięciu na nią przez gracza myszką.
   */
  chaseAway(point) {
    if (this.state === 'IDLE' || this.state === 'FLEEING') {
      this._log('info', `Gracz kliknal Vanesse, ale stan to ${this.state} - bez efektu`);
      return;
    }

    this._setState('FLEEING', 'przegoniona klikiem gracza');
    audio.play('vanessa-przegoniona');
    this.speed = 3.2; // szybki sprint ucieczki!
    this.playAction('sprint');

    const stolen = this.totalStolen;
    const halfStolen = Math.floor(stolen * 0.5);
    const bounty = halfStolen > 10 ? halfStolen : 10;

    // Nagroda trafia do wspólnej puli (przepędzona osobiście przez gracza)
    if (this.economy) {
      this.economy.addMoney(bounty);
    }
    if (this.coinPool) {
      this.coinPool.burst(this.model.position, bounty);
    }

    this._log('good', `Przegoniona klikiem gracza - nagroda ${bounty} zl`, {
      ukradlaLacznie: Math.round(stolen),
      nagroda: bounty,
      polowaWiekszaNiz10: halfStolen > 10,
      trafiloDo: 'kasa gracza',
      ofiara: this.victim ? this.victim.username : null,
    });

    const burstPoint = point || this.model.position;
    const bountyText = `+${fmtShort(bounty)} zł! (Przepędzono Vanessę!)`;
    this.projectAndFloat(
      burstPoint,
      bountyText,
      { crit: true, gold: true }
    );

    // Dłuższy komunikat na górze środkowej części ekranu (2-3 sekundy)
    const bannerTitle = `🦹‍♀️ PRZEPĘDZONO ZŁODZIEJKĘ VANESSĘ!`;
    let bannerBody = `Gracz osobiście przepędził Vanessę kliknięciem myszy i zdobywa <strong>${fmtShort(bounty)} zł</strong>!`;
    if (this.victim && stolen > 0) {
      if (halfStolen > 10) {
        bannerBody += `<br><span class="announcement-sub">Odzyskano 50% skradzionej kwoty (+${fmtShort(bounty)} zł z ${fmtShort(stolen)} zł ukradzionych od <strong class="announcement-victim">@${this.victim.username}</strong>)! Reszta przepadła z Vanessą.</span>`;
      } else {
        bannerBody += `<br><span class="announcement-sub">Vanessa ukradła łącznie ${fmtShort(stolen)} zł od <strong class="announcement-victim">@${this.victim.username}</strong> zanim została przegoniona.</span>`;
      }
    }
    showTopAnnouncement(bannerTitle, bannerBody, 2800);

    if (this.victim && stolen > 0) {
      this.showBubble(halfStolen > 10 ? `Auuuć! Zostaw mnie, oddaję połowę hajsu! 😭🏃‍♀️💨` : `Auuuć! Zostaw mnie, uciekam z tym co mam! 😭🏃‍♀️💨`, 3500);
    } else {
      this.showBubble(FLEE_TAUNTS[Math.floor(Math.random() * FLEE_TAUNTS.length)], 3000);
    }

    if (this.secretTagEl) {
      this.secretTagEl.innerHTML = `Przepędzona kliknięciem! (+${fmtShort(bounty)} zł) 💥`;
    }

    // Wybór narożnika ucieczki (ten sam lub przeciwny)
    this.model.lookAt(this.exitPos.x, 0, this.exitPos.z);
  }

  despawn() {
    this._clearVictimRobbed();
    if (this.model) {
      this._log('info', `Zniknela ze sceny. Lup w tym napadzie: ${Math.round(this.totalStolen)} zl`, {
        stanPrzedZnikniecien: this.state,
        lup: Math.round(this.totalStolen),
      });
    }
    this.state = 'IDLE';

    if (this.nameplateEl) this.nameplateEl.style.display = 'none';
    if (this.bubbleEl) {
      this.bubbleEl.classList.remove('active');
      this.bubbleEl.style.display = 'none';
    }

    if (this.model) {
      this.machine.unregisterClickable(this.model);
      this.scene.remove(this.model);
      this.model = null;
    }

    this.mixer = null;
    this.currentAction = null;
    this.spawnTimer = this._randomSpawnDelay();
  }

  reset() {
    this._clearVictimRobbed();
    this.despawn();
    this.spawnTimer = this._randomSpawnDelay();
  }

  update(delta, camera, canvasRect) {
    // 1. Oczekiwanie na losowy spawn
    if (this.state === 'IDLE') {
      if (this.paused) return; // boss.isActive() - Vanessa nie ma sie prawa pojawic w trakcie walki
      this.spawnTimer -= delta;
      if (this.spawnTimer <= 0) {
        this.spawn();
      }
      return;
    }

    if (!this.model) return;

    // 2. Aktualizacja animacji
    if (this.mixer) {
      this.mixer.update(delta);
    }

    // 3. Maszyna stanów ruchu i kradzieży
    if (this.state === 'SNEAKING') {
      // Dynamicznie śledzimy pozycję ofiary, aby Vanessa podążała za graczem, gdy ten chodzi po arenie
      if (this.victim && this.workerManager && this.victim.workerIndex !== null) {
        const workerEntry = this.workerManager.getWorkerType(this.victim.workerIndex);
        if (workerEntry && workerEntry.obj) {
          const wp = workerEntry.obj.position;
          this.victimWorkerPos = wp.clone();
          const distToCenter = Math.hypot(wp.x, wp.z);
          if (distToCenter > 0.1) {
            const factor = Math.max(0.2, (distToCenter - 0.38) / distToCenter);
            this.targetPos.set(wp.x * factor, 0, wp.z * factor);
          } else {
            this.targetPos.copy(wp);
          }
        }
      }

      const dirX = this.targetPos.x - this.model.position.x;
      const dirZ = this.targetPos.z - this.model.position.z;
      const dist = Math.hypot(dirX, dirZ);

      if (dist <= 0.35) {
        // Dotarła pod postać gracza - rozpoczyna kradzież i unieruchamia ofiarę!
        this._setState('STEALING', 'doszla do celu');
        this._setVictimRobbed();
        this.stealTimer = 0;
        this.stealTickAcc = 0;
        this.playAction('interact-right');
        if (this.victimWorkerPos) {
          this.model.lookAt(this.victimWorkerPos.x, 0, this.victimWorkerPos.z);
        } else {
          this.model.lookAt(0, 0, 0);
        }
        if (this.victim) {
          this.showBubble(`Haha @${this.victim.username}! Zabieram twoją forsę! 😈`, 3000);
        } else {
          this.showBubble(STEAL_TAUNTS[Math.floor(Math.random() * STEAL_TAUNTS.length)]);
        }
      } else {
        const step = Math.min(dist, this.speed * delta);
        this.model.position.x += (dirX / dist) * step;
        this.model.position.z += (dirZ / dist) * step;
        this.model.lookAt(this.targetPos.x, 0, this.targetPos.z);
      }
    } else if (this.state === 'STEALING') {
      this.stealTimer += delta;
      this.stealTickAcc += delta;

      // Co STEAL_TICK_INTERVAL sekund kradnie porcję zł od wybranego gracza z Top 10
      if (this.stealTickAcc >= STEAL_TICK_INTERVAL) {
        this.stealTickAcc -= STEAL_TICK_INTERVAL;

        if (this.victim && this.kickChat) {
          const entry = this.kickChat.leaderboard[this.victim.username.toLowerCase()];
          const available = entry ? entry.totalEarned : 0;
          if (available <= 0) {
            this._log('info', `@${this.victim.username} nie ma juz nic do zabrania`);
          }
          if (available > 0) {
            const wanted = Math.max(STEAL_TICK_MIN, Math.round(available * STEAL_TICK_FRACTION));
            const amount = Math.min(available, wanted);
            const stolen = this.kickChat.stealMoneyFromUser(this.victim.username, amount);
            if (stolen > 0) {
              audio.play('vanessa-kradnie');
              this.totalStolen += stolen;
              this._log('steal', `Ukradla ${Math.round(stolen)} zl od @${this.victim.username}`, {
                tenTyk: Math.round(stolen),
                dorobekPrzed: Math.round(available),
                dorobekPo: Math.round(available - stolen),
                lacznieWTymNapadzie: Math.round(this.totalStolen),
              });
              this.projectAndFloat(this.model.position, `-${fmtShort(stolen)} zł! (@${this.victim.username})`, { steal: true });
            } else {
              this._log('info', `Nie udalo sie nic zabrac @${this.victim.username} (dorobek: ${Math.round(available)} zl)`);
            }
          }
        }
      }

      // Po 5.5 sekundach kradzieży, Vanessa ucieka ze skradzioną kasą
      if (this.stealTimer >= 5.5) {
        this._log('bad', `Konczy kradziez i ucieka z ${Math.round(this.totalStolen)} zl - nikt jej nie przegonil`, {
          lup: Math.round(this.totalStolen),
          ofiara: this.victim ? this.victim.username : null,
        });
        this._setState('ESCAPING', 'uplynal czas kradziezy');
        audio.play('vanessa-ucieka');
        this.speed = 1.6;
        this.playAction('walk');
        if (this.victim) {
          this.showBubble(`Dzięki za hajs, @${this.victim.username}! Nara! 🏃‍♀️💨`);
        } else {
          this.showBubble(ESCAPE_TAUNTS[Math.floor(Math.random() * ESCAPE_TAUNTS.length)]);
        }
        this.model.lookAt(this.exitPos.x, 0, this.exitPos.z);
      }
    } else if (this.state === 'ESCAPING') {
      const dirX = this.exitPos.x - this.model.position.x;
      const dirZ = this.exitPos.z - this.model.position.z;
      const dist = Math.hypot(dirX, dirZ);

      if (dist <= 0.15) {
        this.despawn();
        return;
      } else {
        const step = Math.min(dist, this.speed * delta);
        this.model.position.x += (dirX / dist) * step;
        this.model.position.z += (dirZ / dist) * step;
        this.model.lookAt(this.exitPos.x, 0, this.exitPos.z);
      }
    } else if (this.state === 'FLEEING') {
      const dirX = this.exitPos.x - this.model.position.x;
      const dirZ = this.exitPos.z - this.model.position.z;
      const dist = Math.hypot(dirX, dirZ);

      if (dist <= 0.25) {
        this.despawn();
        return;
      } else {
        const step = Math.min(dist, this.speed * delta);
        this.model.position.x += (dirX / dist) * step;
        this.model.position.z += (dirZ / dist) * step;
        this.model.lookAt(this.exitPos.x, 0, this.exitPos.z);
      }
    }

    // 4. Aktualizacja pozycji plakietki "Vanessa" i dymka w rzucie 3D -> 2D
    if (camera && canvasRect) {
      this.model.getWorldPosition(this._headWorld);
      this._headWorld.y += 0.85;

      this._projected.copy(this._headWorld).project(camera);

      if (this._projected.z >= 1.0) {
        this.nameplateEl.style.display = 'none';
        this.bubbleEl.style.display = 'none';
      } else {
        const sx = canvasRect.left + (this._projected.x * 0.5 + 0.5) * canvasRect.width;
        const sy = canvasRect.top + (-this._projected.y * 0.5 + 0.5) * canvasRect.height;

        this.nameplateEl.style.display = 'flex';
        this.nameplateEl.style.left = `${sx}px`;
        this.nameplateEl.style.top = `${sy - 8}px`;

        this.bubbleEl.style.left = `${sx}px`;
        this.bubbleEl.style.top = `${sy - 42}px`;
      }
    }
  }
}
