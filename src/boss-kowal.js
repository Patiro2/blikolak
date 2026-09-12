import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { strumien, losujInt, losujZ } from './rng.js';
import { showBossNotification } from './ui.js';
import { audio } from './audio.js';

// Mechanika drugiego bossa (tier 2 bankomatu) - Kowal_88. Trzymana w OSOBNYM
// pliku (patrz CLAUDE.md w bankomat-clicker/ - architektura zadania), zeby nie
// dotykac zweryfikowanej logiki bossa 1 w boss.js. BossManager tworzy instancje
// tej klasy w start() (gdy def.mechanika === 'kowal') i deleguje do niej start
// walki, update() w stanie FIGHT, onChatMessage, sprzatanie i sync - HP, FSM
// (IDLE/CUTSCENE/FIGHT/VICTORY), nakladki DOM i kamera zostaja w BossManager.

// Wysokosc pracownika w jednostkach swiata - zmierzone Box3 na natywnym modelu
// character-employee.glb (node: parsowanie chunku JSON glTF, patrz CLAUDE.md
// "Working with this directory"). Kowal ma byc DOKLADNIE 2x wyzszy - patrz
// build() nizej, gdzie mnoznik skali jest wyliczany z Box3 SUROWEGO modelu
// orka, a nie zgadywany.
const WORKER_HEIGHT = 0.7233532667160034;

// Siatka areny 7x7 (zakres -3..3), (0,0) to bankomat. Kowal chodzi WYLACZNIE
// po polach |x|<=2 i |z|<=2, z wykluczeniem bankomatu i czterech pol
// stykajacych sie z nim bokiem. Dzieki temu 4 pola sasiadujace z Kowalem w
// fazie okrazania ZAWSZE miesza sie w siatce 7x7 i zadne z nich nigdy nie
// jest polem bankomatu (patrz zadanie wlasciciela) - nie zmieniac bez
// zrozumienia tego uzasadnienia.
const WYKLUCZONE = new Set(['0,0', '1,0', '-1,0', '0,1', '0,-1']);
const DOZWOLONE_POLA = [];
for (let x = -2; x <= 2; x++) {
  for (let z = -2; z <= 2; z++) {
    if (WYKLUCZONE.has(`${x},${z}`)) continue;
    DOZWOLONE_POLA.push([x, z]);
  }
}

const CYKL_RUCHU = 5.0; // sekund na cala zmiane pola (podswietlenie + marsz)
const CZAS_MARSZU = 2.2; // ostatnia czesc cyklu to faktyczny, powolny marsz
const KOLOR_CEL = 0xff2d2d; // pole, na ktore Kowal zaraz wejdzie - czerwone, zeby bylo wyraznie widac
const KOLOR_OKRAZENIE = 0x2fb4ff; // niebieskie pola fazy okrazania

// Tempo pulsu (rad/s, czas bezwzgledny - patrz oznaczPole w bossattack.js) dla
// obu rodzajow znacznikow Kowala. ~1.75 pelnego cyklu/s (2*PI*1.75 ~ 11) -
// wyraznie szybszy niz stary wzor liczony z ulamka zycia, ktory na
// znacznikach 20-sekundowych (okrazenie) dawal puls ok. 8x wolniejszy niz u
// bossa 1 (zmierzone, patrz zadanie wlasciciela). Boss 1 NIE dostaje tego
// parametru - jego znaczniki maja zostac bit w bit takie jak dzis.
const PULS_KOWAL_RAD_S = 11;

// Teksty dymkow - DOKLADNIE te, bez zmian (wymaganie zadania).
const DYMKI = [
  'szczerze', 'paterson', 'oddaj tts', 'szczerzerson',
  'bałkanerson', 'skoderson', 'oderseon', 'wilkołakerson',
];
const CYKL_DYMKA = 3.2; // sekund miedzy zmianami tekstu w dymku

const PRZYROST_PRZECIAZENIA = 2.5; // % za kazda wiadomosc na czacie
const OPADANIE_PRZECIAZENIA = 0.8; // %/s, dopoki pasek < 100
const OKNO_OKRAZENIA = 20.0; // sekund na dokonczenie fazy okrazania
const OBRAZENIA_OKRAZENIA = 25;
const NAGRODA_OKRAZENIA = 10; // zl dla kazdego gracza na niebieskim polu przy udanym okrazeniu

const LINA_WYSOKOSC = 6.0; // wysokosc, z ktorej Kowal zjezdza na linie
const LINA_CZAS = 1.8; // sekund zjazdu

export class BossKowal {
  constructor(boss) {
    // Referencja do BossManager - scena, fx (znaczniki pol), workerManager,
    // kickChat, economy (seedGry), czyNaliczanieDozwolone (kto jest hostem),
    // _workersOnTile/_userForWorker/_killUser/damage/_log - patrz boss.js.
    this.boss = boss;

    this.model = null;
    this.mixer = null;
    this.currentAction = null;
    this.animations = [];
    this.mlotObj = null;

    this.fazaWejscia = false;
    this.linaObj = null;
    this._wejscieT = 0;

    this.x = 0;
    this.z = 0;
    this.celX = 0;
    this.celZ = 0;
    this.startX = 0;
    this.startZ = 0;
    this.cykl = 0;
    this.licznikPol = 0;
    this._znacznikCelu = null;

    this.dymekTekst = '';
    this._dymekT = 0;
    this.licznikDymkow = 0;

    this.przeciazenie = 0; // 0..100
    this.faza = 'RUCH'; // 'RUCH' | 'OKRAZENIE'
    this.okrazenieT = 0;
    this._poleOkrazenia = [];
    this._znacznikiOkrazenia = [];
    // Ustawiane, gdy pasek dobije do 100% W TRAKCIE MARSZU (patrz
    // onChatMessage/_onWejscieNaPole) - trzyma decyzje "wejdz w OKRAZENIE" do
    // chwili, gdy krok sie dokonczy i this.x/this.z znowu odpowiadaja polu,
    // na ktorym model faktycznie stoi (diagnoza bledu z zadania wlasciciela).
    this._okrazenieOczekuje = false;
  }

  // ================= BUDOWA MODELU =================

  /** Buduje postac Kowala (character-orc) w skali 2x pracownika, z mlotem w rece. */
  build() {
    const boss = this.boss;
    const char = SkeletonUtils.clone(boss.orcTemplate);
    this.animations = boss.orcAnimations || [];

    // Skala: mierzymy Box3 SUROWEGO modelu (skala 1) zamiast zakladac stala
    // wysokosc orka - jesli model kiedys sie zmieni, mnoznik i tak wyjdzie
    // poprawny. WORKER_HEIGHT to zmierzona wysokosc character-employee.glb.
    const box = new THREE.Box3().setFromObject(char);
    const wysokoscNatywna = Math.max(0.0001, box.max.y - box.min.y);
    const skala = (2 * WORKER_HEIGHT) / wysokoscNatywna;
    char.scale.setScalar(skala);
    this.skala = skala;
    this.wysokoscNatywna = wysokoscNatywna;

    char.traverse((n) => {
      if (n.isMesh) {
        n.castShadow = true;
        n.receiveShadow = true;
      }
    });

    this.model = char;
    this.mixer = new THREE.AnimationMixer(char);
    this.currentAction = null;

    this._zalozMlot();

    boss.scene.add(char);
    return char;
  }

  /**
   * Mlot zbudowany z prymitywow (plaskie kolory, bez tekstury, w duchu
   * Kenneya) - w zadnej z 10 paczek Kenneya nie ma modelu mlota ani niczego
   * mlotopodobnego (sprawdzone nazwy wszystkich 294 modeli, patrz raport
   * rozpoznania w zadaniu). Doczepiony do kosci 'arm-right' - identyczny rig
   * jak reszta postaci Kenneya (patrz _zalozBron w boss.js, ktore robi to
   * samo z blasterem boss 1).
   */
  _zalozMlot() {
    const reka = this.model.getObjectByName('arm-right');
    if (!reka) return;

    const grupa = new THREE.Group();

    const trzonek = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.04, 0.55, 8),
      new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.9 }),
    );
    trzonek.position.set(0, 0.28, 0);
    grupa.add(trzonek);

    const glowica = new THREE.Mesh(
      new THREE.BoxGeometry(0.36, 0.2, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x7d7d7d, metalness: 0.2, roughness: 0.55 }),
    );
    glowica.position.set(0, 0.56, 0);
    grupa.add(glowica);

    grupa.traverse((n) => {
      if (n.isMesh) n.castShadow = true;
    });

    // Trzonek w dloni, glowica skierowana w gore - reka w spoczynku rigu
    // Kenneya zwisa wzdluz ciala, wiec lekkie pochylenie w bok robi z tego
    // pozycje "trzyma mlot przy nodze".
    grupa.position.set(0.02, -0.32, 0.03);
    grupa.rotation.set(0, 0, Math.PI / 10);
    reka.add(grupa);
    this.mlotObj = grupa;
  }

  playAction(name, opts = {}) {
    const clip = THREE.AnimationClip.findByName(this.animations, name);
    if (!clip || !this.mixer) return null;
    const next = this.mixer.clipAction(clip);
    if (opts.once) {
      next.setLoop(THREE.LoopOnce);
      next.clampWhenFinished = true;
    }
    if (this.currentAction === next) {
      if (opts.forceRestart) next.reset().play();
      return next;
    }
    if (this.currentAction && !opts.hard) {
      this.currentAction.crossFadeTo(next, 0.2, false);
    }
    next.reset().play();
    this.currentAction = next;
    return next;
  }

  // ================= WEJSCIE NA LINIE =================

  /** Zamiast cutscenki bossa 1: Kowal zjezdza na linie z gory na pole startowe. */
  beginEntrance() {
    const pole = this._wybierzPole();
    this.x = pole.x;
    this.z = pole.z;

    if (this.model) {
      this.model.position.set(this.x, LINA_WYSOKOSC, this.z);
      this.model.rotation.set(0, 0, 0);
      this.model.lookAt(this.model.position.x, this.model.position.y, this.model.position.z + 10);
    }

    const lina = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 1, 6),
      new THREE.MeshBasicMaterial({ color: 0x3a2a1a }),
    );
    lina.position.set(this.x, (LINA_WYSOKOSC + 8) / 2, this.z);
    lina.scale.y = 8;
    this.boss.scene.add(lina);
    this.linaObj = lina;

    this.fazaWejscia = true;
    this._wejscieT = 0;
    audio.play('boss-wejscie');
    this.playAction('fall', { hard: true }) || this.playAction('idle', { hard: true });
    this.boss._log('spawn', `Kowal_88 zjezdza na linie na pole [${this.x}, ${this.z}]`);
  }

  _updateEntrance(delta) {
    this._wejscieT += delta;
    const u = Math.min(1, this._wejscieT / LINA_CZAS);
    const y = LINA_WYSOKOSC * (1 - u);
    if (this.model) this.model.position.y = y;
    if (this.linaObj) {
      const sufit = 8;
      const dl = Math.max(0.001, sufit - y);
      this.linaObj.scale.y = dl;
      this.linaObj.position.set(this.x, y + dl / 2, this.z);
    }
    if (u >= 1) {
      this.fazaWejscia = false;
      if (this.linaObj) {
        this.boss.scene.remove(this.linaObj);
        this.linaObj.geometry.dispose();
        this.linaObj.material.dispose();
        this.linaObj = null;
      }
      if (this.model) this.model.position.y = 0;
      this.playAction('idle', { hard: true });
      this._rozpocznijNowyCykl();
    }
  }

  // ================= LOSOWANIE POL (DETERMINISTYCZNE) =================

  /**
   * Wybor kolejnego pola - zakotwiczony w licznikPol (strumien
   * `${seed}:kowal-pole:${idWalki}:${N}`), wiec KAZDA otwarta karta gry
   * wybiera DOKLADNIE to samo pole (dokladnie jak _wybierzPoleAtaku w
   * boss.js). Pula to 20 pol dozwolonych (patrz DOZWOLONE_POLA) - bankomat
   * i jego 4 sasiednie pola sa wykluczone raz na zawsze, wiec nie trzeba tu
   * zadnej petli odrzucajacej.
   */
  _wybierzPole() {
    this.licznikPol += 1;
    const seed = this.boss.economy.state.seedGry;
    const idWalki = this.boss.pendingTier;
    const rng = strumien(`${seed}:kowal-pole:${idWalki}:${this.licznikPol}`);
    const idx = losujInt(rng, 0, DOZWOLONE_POLA.length - 1);
    const [x, z] = DOZWOLONE_POLA[idx];
    return { x, z };
  }

  _rozpocznijNowyCykl() {
    this.startX = this.x;
    this.startZ = this.z;
    const cel = this._wybierzPole();
    this.celX = cel.x;
    this.celZ = cel.z;
    this.cykl = 0;
    if (this._znacznikCelu) {
      this.boss.fx.usunZnacznik(this._znacznikCelu);
      this._znacznikCelu = null;
    }
    this._znacznikCelu = this.boss.fx.oznaczPole(this.celX, this.celZ, KOLOR_CEL, CYKL_RUCHU, PULS_KOWAL_RAD_S);
    this.boss._log('info', `Kowal_88 bierze na cel pole [${this.celX}, ${this.celZ}]`, { pole: [this.celX, this.celZ] });
  }

  _updateRuch(delta) {
    this.cykl += delta;
    const startMarszu = CYKL_RUCHU - CZAS_MARSZU;
    if (this.model) {
      if (this.cykl < startMarszu) {
        this.model.position.set(this.startX, 0, this.startZ);
        this.model.lookAt(this.celX, this.model.position.y, this.celZ);
        this.playAction('idle');
      } else {
        const u = Math.min(1, (this.cykl - startMarszu) / CZAS_MARSZU);
        this.model.position.set(
          this.startX + (this.celX - this.startX) * u,
          0,
          this.startZ + (this.celZ - this.startZ) * u,
        );
        this.model.lookAt(this.celX, 0, this.celZ);
        this.playAction('walk');
      }
    }
    if (this.cykl >= CYKL_RUCHU) {
      this._onWejscieNaPole();
    }
  }

  /** Kto stoi na polu, na ktore Kowal wlasnie wchodzi - ginie (patrz boss._killUser). */
  _onWejscieNaPole() {
    this.x = this.celX;
    this.z = this.celZ;
    if (this._znacznikCelu) {
      this.boss.fx.usunZnacznik(this._znacznikCelu);
      this._znacznikCelu = null;
    }
    const trafieni = this.boss._workersOnTile(this.x, this.z);
    for (const entry of trafieni) {
      const nick = this.boss._userForWorker(entry);
      if (nick) this.boss._killUser(nick, { source: 'kowal' });
    }
    if (this._okrazenieOczekuje) {
      // Krok sie wlasnie dokonczyl - this.x/this.z sa TERAZ rowne polu, na
      // ktorym model faktycznie stoi (ustawione dwie linijki wyzej), wiec
      // dopiero teraz _sasiednie() w _rozpocznijOkrazenie() policzy 4 pola
      // okrazania wokol prawdziwej pozycji, a nie tej sprzed marszu (patrz
      // onChatMessage i zadanie wlasciciela - zmierzony bug zamrozonego
      // modelu miedzy polami).
      this._rozpocznijOkrazenie();
    } else {
      this._rozpocznijNowyCykl();
    }
  }

  // ================= DYMKI NAD GLOWA =================

  _updateDymek(delta) {
    this._dymekT -= delta;
    if (this._dymekT <= 0 || !this.dymekTekst) {
      this._dymekT = CYKL_DYMKA;
      this.licznikDymkow += 1;
      const seed = this.boss.economy.state.seedGry;
      const idWalki = this.boss.pendingTier;
      const rng = strumien(`${seed}:kowal-dymek:${idWalki}:${this.licznikDymkow}`);
      this.dymekTekst = losujZ(rng, DYMKI);
    }
  }

  // ================= PASEK PRZECIAZENIA I FAZA OKRAZANIA =================

  /**
   * Kazda wiadomosc na czacie (dowolna, od dowolnego widza, takze spoza
   * rankingu) podbija pasek o PRZYROST_PRZECIAZENIA. Start fazy okrazania po
   * przekroczeniu 100% jest DECYZJA, ktora podejmuje wylacznie host (patrz
   * boss.czyNaliczanieDozwolone) - inaczej lekki rozjazd czasu dotarcia
   * wiadomosci miedzy kartami moglby sprawic, ze jedna karta wejdzie w faze
   * okrazania wczesniej niz druga. Widz i tak dostanie faze przez
   * getSyncState()/applySync(), dokladnie jak HP bossa.
   */
  onChatMessage(username, content) {
    if (this.faza !== 'RUCH') return;
    this.przeciazenie = Math.min(100, this.przeciazenie + PRZYROST_PRZECIAZENIA);
    if (this._okrazenieOczekuje || this.przeciazenie < 100) return;
    const jestemHostem = !this.boss.czyNaliczanieDozwolone || this.boss.czyNaliczanieDozwolone();
    if (!jestemHostem) return;
    const startMarszu = CYKL_RUCHU - CZAS_MARSZU;
    if (this.cykl >= startMarszu) {
      // Pasek dobil w TRAKCIE MARSZU - this.x/this.z sa dalej rowne polu
      // STARTOWEMU (aktualizacja dopiero w _onWejscieNaPole), a model stoi
      // gdzies w polowie drogi do celu. Wejscie w OKRAZENIE teraz policzyloby
      // 4 sasiednie pola z bledngo (opuszczanego) pola - zmierzony bug z
      // zadania wlasciciela. Zamiast przerywac krok w polowie, czekamy do
      // _onWejscieNaPole (najwyzej CZAS_MARSZU, czyli max 2.2 s), gdzie
      // this.x/this.z beda juz rowne polu, na ktorym model faktycznie stoi.
      this._okrazenieOczekuje = true;
    } else {
      // Poza marszem (podswietlenie pola docelowego) model juz stoi
      // dokladnie na this.x/this.z - mozna wejsc w OKRAZENIE od razu, jak
      // dotychczas.
      this._rozpocznijOkrazenie();
    }
  }

  _sasiednie() {
    return [
      [this.x + 1, this.z],
      [this.x - 1, this.z],
      [this.x, this.z + 1],
      [this.x, this.z - 1],
    ];
  }

  _rozpocznijOkrazenie() {
    this._okrazenieOczekuje = false;
    this.faza = 'OKRAZENIE';
    this.okrazenieT = OKNO_OKRAZENIA;
    if (this._znacznikCelu) {
      this.boss.fx.usunZnacznik(this._znacznikCelu);
      this._znacznikCelu = null;
    }
    this._poleOkrazenia = this._sasiednie();
    this._znacznikiOkrazenia = this._poleOkrazenia.map(([x, z]) => this.boss.fx.oznaczPole(x, z, KOLOR_OKRAZENIE, OKNO_OKRAZENIA, PULS_KOWAL_RAD_S));
    this.playAction('static') || this.playAction('idle');
    showBossNotification(
      'boss',
      '⚡ KOWAL_88 PRZECIĄŻONY!',
      `Stańcie JEDNOCZEŚNIE na 4 niebieskich polach wokół niego - macie <strong>${OKNO_OKRAZENIA}</strong> sekund!`,
    );
    this.boss._log('bad', 'Kowal_88 przeciazony - startuje faza okrazania', { pola: this._poleOkrazenia });
  }

  /** Wersja bez logow/powiadomien - dopasowanie widza dolaczajacego w trakcie fazy (patrz applySync). */
  _rozpocznijOkrazenieLokalnie(okrazenieT) {
    this._okrazenieOczekuje = false;
    this.faza = 'OKRAZENIE';
    this.okrazenieT = typeof okrazenieT === 'number' ? okrazenieT : OKNO_OKRAZENIA;
    if (this._znacznikCelu) {
      this.boss.fx.usunZnacznik(this._znacznikCelu);
      this._znacznikCelu = null;
    }
    this._poleOkrazenia = this._sasiednie();
    this._znacznikiOkrazenia = this._poleOkrazenia.map(([x, z]) => this.boss.fx.oznaczPole(x, z, KOLOR_OKRAZENIE, this.okrazenieT, PULS_KOWAL_RAD_S));
  }

  _wyczyscZnacznikiOkrazenia() {
    for (const z of this._znacznikiOkrazenia) this.boss.fx.usunZnacznik(z);
    this._znacznikiOkrazenia = [];
    this._poleOkrazenia = [];
  }

  /** Wolane WYLACZNIE na hoscie (patrz update()) - sprawdza zajetosc 4 pol i limit czasu. */
  _updateOkrazenie(delta) {
    this.okrazenieT -= delta;
    const udane = this._poleOkrazenia.length === 4
      && this._poleOkrazenia.every(([x, z]) => this.boss._workersOnTile(x, z).length > 0);
    if (udane) {
      this._zakonczOkrazenie(true);
      return;
    }
    if (this.okrazenieT <= 0) {
      this._zakonczOkrazenie(false);
    }
  }

  _zakonczOkrazenie(sukces) {
    // Kopia PRZED czyszczeniem znacznikow - _wyczyscZnacznikiOkrazenia() zeruje
    // this._poleOkrazenia, a nagroda ponizej potrzebuje tych 4 pol.
    const poleOkrazenia = this._poleOkrazenia.slice();
    this._wyczyscZnacznikiOkrazenia();
    this.przeciazenie = 0;
    this.faza = 'RUCH';
    if (sukces) {
      audio.play('boss-trafienie');
      this.boss.damage(OBRAZENIA_OKRAZENIA);

      // Nagroda 10 zl dla KAZDEGO gracza stojacego na ktoromkolwiek z 4
      // niebieskich pol w chwili sukcesu - kazda osoba osobno (dwoje na
      // jednym polu dostaje kazde po 10 zl), zbierane do zbioru nickow zeby
      // ta sama osoba nie dostala dwa razy, gdyby stala na dwoch polach
      // naraz. _zakonczOkrazenie jest wolane WYLACZNIE z _updateOkrazenie,
      // ktora sama jest host-gated w update() - wiec to naliczenie jest
      // rowniez bezpiecznie jednorazowe (dokladnie jak nagroda za trafienie
      // bossa 1 w boss.js _onCorrectAnswer i jak zlota moneta w goldcoin.js).
      const nagrodzeni = new Set();
      for (const [x, z] of poleOkrazenia) {
        const trafieni = this.boss._workersOnTile(x, z);
        for (const entry of trafieni) {
          const nick = this.boss._userForWorker(entry);
          if (!nick || nagrodzeni.has(nick)) continue;
          nagrodzeni.add(nick);
          const user = this.boss.kickChat ? this.boss.kickChat.getUserForWorker(entry.typeIndex) : null;
          const kolor = user ? user.color : undefined;
          // countsAsClick=false - to nie jest komenda "klik" z czatu, wiec
          // licznik klikniec widza w rankingu nie moze urosnac (wymaganie
          // zadania, patrz tez goldcoin.js/_collectByWorker).
          if (this.boss.kickChat) this.boss.kickChat.recordEarned(nick, NAGRODA_OKRAZENIA, kolor, false);
          if (this.boss.economy) this.boss.economy.addMoney(NAGRODA_OKRAZENIA);
          if (entry.obj && this.boss.projectAndFloat) {
            const origin = entry.obj.position.clone().add(new THREE.Vector3(0, 1.6, 0));
            this.boss.projectAndFloat(origin, `+${NAGRODA_OKRAZENIA} zł`, { gold: true });
          }
        }
      }

      showBossNotification(
        'hit',
        '💥 OKRĄŻENIE UDANE!',
        `Kowal_88 traci ${OBRAZENIA_OKRAZENIA} HP! Każdy na niebieskim polu dostaje ${NAGRODA_OKRAZENIA} zł!`,
      );
      this.boss._log('good', `Faza okrazania udana - Kowal_88 traci ${OBRAZENIA_OKRAZENIA} HP, nagrodzeni: ${[...nagrodzeni].join(', ') || 'brak'}`);
    } else {
      showBossNotification(
        'help',
        '⌛ CZAS MINĄŁ!',
        'Nie udało się okrążyć Kowala_88 na czas - pasek przeciążenia wraca do zera.',
      );
      this.boss._log('bad', 'Faza okrazania nieudana - czas minal, pasek wraca do zera');
    }
    if (this.boss.state === 'FIGHT') this._rozpocznijNowyCykl();
  }

  /** Wersja bez logow/dmg - widz dopasowuje sie do konca fazy zaobserwowanego w sync. */
  _zakonczOkrazenieLokalnie() {
    this._wyczyscZnacznikiOkrazenia();
    this.faza = 'RUCH';
  }

  // ================= UPDATE GLOWNY =================

  update(delta) {
    if (this.mixer) this.mixer.update(delta);

    if (this.fazaWejscia) {
      this._updateEntrance(delta);
      return;
    }

    this._updateDymek(delta);

    if (this.faza === 'RUCH') {
      if (this.przeciazenie < 100) {
        this.przeciazenie = Math.max(0, this.przeciazenie - OPADANIE_PRZECIAZENIA * delta);
      }
      this._updateRuch(delta);
    } else if (this.faza === 'OKRAZENIE') {
      const jestemHostem = !this.boss.czyNaliczanieDozwolone || this.boss.czyNaliczanieDozwolone();
      if (jestemHostem) this._updateOkrazenie(delta);
    }
  }

  // ================= SPRZATANIE =================

  teardown() {
    if (this._znacznikCelu) {
      this.boss.fx.usunZnacznik(this._znacznikCelu);
      this._znacznikCelu = null;
    }
    this._wyczyscZnacznikiOkrazenia();
    if (this.linaObj) {
      this.boss.scene.remove(this.linaObj);
      this.linaObj.geometry.dispose();
      this.linaObj.material.dispose();
      this.linaObj = null;
    }
    this.mixer = null;
    this.currentAction = null;
  }

  // ================= SYNCHRONIZACJA =================

  getSyncState() {
    return {
      x: this.x,
      z: this.z,
      celX: this.celX,
      celZ: this.celZ,
      cykl: this.cykl,
      licznikPol: this.licznikPol,
      przeciazenie: this.przeciazenie,
      faza: this.faza,
      okrazenieT: this.okrazenieT,
      // Patrz komentarz przy polu w konstruktorze i przy onChatMessage - bez
      // synchronizacji tej flagi karta widza moglaby wejsc w faze OKRAZENIE w
      // innym momencie niz host (jej wlasny _onWejscieNaPole odpala sie
      // lokalnie i deterministycznie, wiec musi znac ta sama decyzje).
      okrazenieOczekuje: this._okrazenieOczekuje,
    };
  }

  /**
   * Widz WYLACZNIE wyswietla zsynchronizowana wartosc paska i faze - host
   * jest zrodlem prawdy dla przejsc miedzy RUCH i OKRAZENIE (patrz
   * onChatMessage). Pole docelowe/licznik sa i tak deterministyczne na
   * kazdej karcie, ale wyrownujemy je tutaj tez - np. gdy widz dolacza w
   * trakcie marszu (patrz startFromSync w boss.js).
   */
  applySync(state) {
    if (!state) return;

    if (typeof state.okrazenieOczekuje === 'boolean') this._okrazenieOczekuje = state.okrazenieOczekuje;

    if (typeof state.faza === 'string' && state.faza !== this.faza) {
      if (state.faza === 'OKRAZENIE') this._rozpocznijOkrazenieLokalnie(state.okrazenieT);
      else this._zakonczOkrazenieLokalnie();
    }
    if (typeof state.przeciazenie === 'number') this.przeciazenie = state.przeciazenie;
    if (this.faza === 'OKRAZENIE' && typeof state.okrazenieT === 'number') {
      this.okrazenieT = state.okrazenieT;
    }

    if (typeof state.licznikPol === 'number' && state.licznikPol !== this.licznikPol) {
      this.licznikPol = state.licznikPol;
      this.x = state.x;
      this.z = state.z;
      this.celX = state.celX;
      this.celZ = state.celZ;
      this.cykl = typeof state.cykl === 'number' ? state.cykl : 0;
      if (this.model) this.model.position.set(this.x, 0, this.z);
      if (this._znacznikCelu) {
        this.boss.fx.usunZnacznik(this._znacznikCelu);
        this._znacznikCelu = null;
      }
      if (this.faza === 'RUCH') {
        this._znacznikCelu = this.boss.fx.oznaczPole(this.celX, this.celZ, KOLOR_CEL, Math.max(0.1, CYKL_RUCHU - this.cykl), PULS_KOWAL_RAD_S);
      }
    }
  }

  /** Widz dolaczajacy w trakcie walki - ustawienie od razu w finalnej pozycji, bez wejscia na linie. */
  startFromSync(state) {
    this.x = state && typeof state.x === 'number' ? state.x : 0;
    this.z = state && typeof state.z === 'number' ? state.z : 0;
    this.celX = state && typeof state.celX === 'number' ? state.celX : this.x;
    this.celZ = state && typeof state.celZ === 'number' ? state.celZ : this.z;
    this.startX = this.x;
    this.startZ = this.z;
    this.cykl = state && typeof state.cykl === 'number' ? state.cykl : 0;
    this.licznikPol = state && typeof state.licznikPol === 'number' ? state.licznikPol : 0;
    this.przeciazenie = state && typeof state.przeciazenie === 'number' ? state.przeciazenie : 0;
    this.faza = state && state.faza === 'OKRAZENIE' ? 'OKRAZENIE' : 'RUCH';
    this._okrazenieOczekuje = !!(state && state.okrazenieOczekuje);

    if (this.model) {
      this.model.position.set(this.x, 0, this.z);
      this.model.lookAt(this.celX, 0, this.celZ);
    }
    this.playAction('idle', { hard: true });

    if (this.faza === 'OKRAZENIE') {
      this._rozpocznijOkrazenieLokalnie(state ? state.okrazenieT : OKNO_OKRAZENIA);
    } else {
      this._znacznikCelu = this.boss.fx.oznaczPole(this.celX, this.celZ, KOLOR_CEL, Math.max(0.1, CYKL_RUCHU - this.cykl), PULS_KOWAL_RAD_S);
    }
  }
}
