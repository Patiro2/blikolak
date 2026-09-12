import * as THREE from 'three';
import { COUNTRIES, COUNTRY_CODES, normalizeCountryName } from './countries.js';

// Naprawa koloru/rozdzielczosci flag (dwie NIEZALEZNE przyczyny):
//
// 1) Zarzadzanie kolorem: renderer ma outputColorSpace = SRGBColorSpace i
//    ACESFilmicToneMapping (patrz src/scene.js) - tekstura bez
//    texture.colorSpace = SRGBColorSpace jest traktowana jako dane LINIOWE,
//    wiec kolory wychodza wyplowiale/przesuniete, a plaska grafika bez
//    material.toneMapped = false dodatkowo traci nasycenie przez tone
//    mapping pomyslany do oswietlonych scen 3D, nie plaskich ikon.
// 2) Paleta zrodlowa: caly pakiet flag uzywa jednej przygaszonej,
//    zestylizowanej palety (9 kolorow odpowiada za wiekszosc powierzchni
//    wszystkich 232 flag) - np. biel to #EEEEF7 (lekko niebieskawa), a nie
//    prawdziwa biel. To NIE jest blad renderu, tak wygladaja same pliki
//    zrodlowe (PNG i SVG identycznie) - poprawka wymaga podmiany kolorow.
//
// Rozwiazanie: SVG (wektor, wiec dowolna rozdzielczosc) ladowany jako tekst,
// kolory z palety podmieniane na nasycone, rasteryzacja przez Image+canvas
// w 256x256 (dawne PNG mialy 64x64), i z canvasu CanvasTexture z poprawnym
// colorSpace i anizotropia. Wynik cache'owany po kodzie kraju - flaga
// rasteryzuje sie raz na sesje, kazda kolejna runda z tym samym krajem
// dostaje ta sama tekstura z cache (zero nowych obiektow, zero wycieku).
const PALETA_KOLOROW = {
  '#EEEEF7': '#FFFFFF',
  '#EC2037': '#D7141A',
  '#25252A': '#111111',
  '#FCC920': '#FFCE00',
  '#259F6C': '#009B3A',
  '#3439CB': '#0038A8',
  '#392D8C': '#24246E',
  '#5193EE': '#5B9BD5',
  '#C4863B': '#B8762E',
};

const ROZMIAR_TEKSTURY_FLAGI = 256; // bylo 64 (PNG "Default")

// kod kraju -> Promise<THREE.CanvasTexture>. Modul jest singletonem na karte
// (ES modules), wiec ten cache dziala "raz na sesje" nawet gdyby kiedys
// powstala wiecej niz jedna instancja FlagBattleManager na tej samej karcie.
const cacheTeksturFlag = new Map();

function podmienKoloryNaNasycone(svgText) {
  let out = svgText;
  for (const [stary, nowy] of Object.entries(PALETA_KOLOROW)) {
    out = out.split(stary).join(nowy);
  }
  return out;
}

/**
 * Pobiera SVG flagi, podmienia paleta, rasteryzuje do canvasu 256x256 i
 * zwraca CanvasTexture z poprawnym colorSpace/anizotropia. Wynik cache'owany
 * po kodzie kraju - druga i kolejne prosby o te sama flage dostaja gotowa
 * tekstura z cache, bez ponownego pobierania/rasteryzacji.
 */
function zaladujTeksturaFlagi(kod, renderer) {
  if (cacheTeksturFlag.has(kod)) return cacheTeksturFlag.get(kod);

  const promise = (async () => {
    const resp = await fetch(`assets/flags-vector/${kod}.svg`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} przy pobieraniu assets/flags-vector/${kod}.svg`);
    const svgTextOryginalny = await resp.text();
    const svgText = podmienKoloryNaNasycone(svgTextOryginalny);

    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error(`Blad rasteryzacji SVG flagi ${kod}`));
        im.src = url;
      });

      const canvas = document.createElement('canvas');
      canvas.width = ROZMIAR_TEKSTURY_FLAGI;
      canvas.height = ROZMIAR_TEKSTURY_FLAGI;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, ROZMIAR_TEKSTURY_FLAGI, ROZMIAR_TEKSTURY_FLAGI);

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      if (renderer && renderer.capabilities && typeof renderer.capabilities.getMaxAnisotropy === 'function') {
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      }
      texture.needsUpdate = true;
      return texture;
    } finally {
      URL.revokeObjectURL(url);
    }
  })();

  cacheTeksturFlag.set(kod, promise);
  // Nieudana probka NIE zostaje w cache na zawsze - inaczej jeden chwilowy
  // blad sieci blokowalby te flage do konca sesji. Kolejne zadanie tego
  // samego kodu sprobuje ponownie.
  promise.catch(() => cacheTeksturFlag.delete(kod));
  return promise;
}

export class FlagBattleManager {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    
    this.state = 'IDLE'; // IDLE, WAITING, BATTLE, REWARD
    this.timer = 0;
    this.tile = null; // {x, z}
    this.players = []; // [{ typeIndex, username, score }]
    
    this.currentFlag = null; // np. 'PL'
    this._loadedFlag = null; // ostatnia flaga, ktorej tekstura zostala zaladowana (uzywane w applySync u widza)
    this.flagsGuessed = 0; // Ile flag zgadnięto w obecnej bitwie
    
    this.rewardTimer = 0;
    this.winner = null;

    // Wolane po kazdym announce() z tekstem - main.js podpina tu rozgloszenie
    // przez kanal realtime (zdarzenie 'flaga-info'), zeby widzowie widzieli
    // narracje bitwy natychmiast, a nie dopiero przy nastepnym snapshocie co 2 s.
    // Domyslnie no-op, gdyby main.js tego nie podpial.
    this.onAnnounce = () => {};

    // Mesh podświetlający pole
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({ 
      color: 0x00ff00, 
      transparent: true, 
      opacity: 0.5,
      depthWrite: false
    });
    this.highlightMesh = new THREE.Mesh(geo, mat);
    this.highlightMesh.rotation.x = -Math.PI / 2;
    this.highlightMesh.position.y = 0.035; // Leciutko nad płytką
    this.highlightMesh.visible = false;
    this.scene.add(this.highlightMesh);

    // Sprite z flagą. toneMapped = false - to plaska 2D grafika (ikona), nie
    // oswietlona powierzchnia 3D, wiec ACESFilmicToneMapping z renderera nie
    // powinien jej przygaszac/przesuwac kolorow (patrz komentarz nad PALETA_KOLOROW).
    this.flagMaterial = new THREE.SpriteMaterial({ color: 0xffffff, toneMapped: false });
    this.flagSprite = new THREE.Sprite(this.flagMaterial);
    this.flagSprite.scale.set(1.5, 1.0, 1.0); // proporcja flagi
    this.flagSprite.position.y = 3.0; // Nad polem
    this.flagSprite.visible = false;
    this.scene.add(this.flagSprite);

    this._flagReqId = 0; // chroni przed wyscigiem, gdy runda zmieni sie zanim async rasteryzacja skonczy
  }

  setContext({ workerManager, kickChat, economy, isHost }) {
    this.workerManager = workerManager;
    this.kickChat = kickChat;
    this.economy = economy;
    // NAPRAWA: przed ta zmiana kazda otwarta karta (host i kazdy widz) miala
    // wlasna, niezalezna instancje FlagBattleManager i tick() na kazdej z nich
    // losowal Math.random() SAM - inny kafelek, inna flaga, w innym momencie.
    // To dokladnie ta klasa bledu, ktora rng.js opisuje jako niedozwolona w
    // tej grze (kazda karta ma wlasna symulacje, wiec goly Math.random() daje
    // rozjazd) i ktora a3773a3 juz raz naprawial dla klikow/pozycji - tu
    // wrocila swiezo w nowym module. Teraz decyzje (kafelek, flaga, wygrana,
    // kasa) podejmuje WYLACZNIE host; widz dostaje gotowy stan przez
    // getSyncState/applySync (patrz main.js: zbierzStan/zastosujStanZSerwera),
    // dokladnie jak boss.js.
    this.isHost = !!isHost;
  }

  isTileLocked(x, z, typeIndex) {
    if (!this.tile) return false;
    if (this.tile.x !== x || this.tile.z !== z) return false;
    
    if (this.state === 'WAITING') {
      // Można wejść, dopóki nie ma 2 graczy
      return false;
    }
    
    if (this.state === 'BATTLE') {
      // W bitwie na to pole mogą wejść/zostać tylko ci dwaj gracze (chociaż w sumie są tam zamknięci)
      return !this.players.some(p => p.typeIndex === typeIndex);
    }
    
    if (this.state === 'REWARD') {
      // Tylko zwycięzca ma prawo być na tym polu
      return !this.winner || this.winner.typeIndex !== typeIndex;
    }
    
    return false;
  }

  tick(dt) {
    // Pulsowanie koloru jest funkcja Date.now(), nie losowania - moze bez
    // ryzyka leciec na kazdej karcie, host i widz pulsuja identycznie.
    if (this.state === 'BATTLE') {
      const s = Math.sin(Date.now() * 0.005) * 0.5 + 0.5;
      this.highlightMesh.material.color.setRGB(1, s * 0.5, s * 0.5);
    } else if (this.state === 'REWARD') {
      const s = Math.sin(Date.now() * 0.003) * 0.5 + 0.5;
      this.highlightMesh.material.color.setRGB(1, 0.8 + s * 0.2, 0);
    }

    // Reszta (losowanie kafelka/flagi, przejscia stanow, przyznawanie kasy)
    // to decyzje - te podejmuje WYLACZNIE host. Widz dostaje gotowy wynik
    // przez applySync() wolane z main.js po kazdym snapshocie.
    if (!this.isHost) return;

    if (this.state === 'IDLE') {
      this.timer += dt;
      if (this.timer >= 30) {
        this.spawnBattleSquare();
      }
    }
    else if (this.state === 'WAITING') {
      this.checkPlayersEntry();
    }
    else if (this.state === 'REWARD') {
      this.rewardTimer += dt;

      // Pasywny dochód (np. tick co 1 sekundę by dawał +2zł)
      // Żeby zrealizować 2 zł / sek, możemy sumować czas ułamkowy, albo dawać co 1 sek:
      if (!this._lastRewardTime) this._lastRewardTime = 0;
      this._lastRewardTime += dt;
      if (this._lastRewardTime >= 1.0) {
        this._lastRewardTime -= 1.0;
        this.economy.addMoney(2);
        if (this.winner && this.winner.username) {
           this.kickChat.recordEarned(this.winner.username, 2);
           // Uwaga: byl tu zalazek dymka "+2 zl" doklejanego do #ui-layer, ale
           // taki element NIE ISTNIEJE w index.html (kontener na floatery to
           // #floaters), wiec appendChild leciał na null i rzucal wyjatkiem co
           // sekunde. tick() jest wolany z animate() BEZ try/catch, wiec kazdy
           // taki wyjatek przerywal reszte klatki - w tym renderowanie sceny.
           // Blok byl przy tym niedokonczony (brak rzutowania na ekran i brak
           // usuwania elementu), wiec zostal usuniety zamiast naprawiony.
           // Dymek mozna dodac osobno przez projectAndFloat z main.js.
        }
      }

      if (this.rewardTimer >= 30) {
        this.reset();
      }
    }
  }

  spawnBattleSquare() {
    // Losujemy pole na siatce -3 do 3, bez (0,0) (bankomat)
    let rx, rz;
    do {
      rx = Math.floor(Math.random() * 7) - 3;
      rz = Math.floor(Math.random() * 7) - 3;
    } while (rx === 0 && rz === 0);
    
    this.tile = { x: rx, z: rz };
    this.state = 'WAITING';
    this.timer = 0;
    
    this.highlightMesh.position.x = rx;
    this.highlightMesh.position.z = rz;
    this.highlightMesh.material.color.setHex(0x00ff00);
    this.highlightMesh.visible = true;
    
    this.flagSprite.position.set(rx, 2.5, rz);
    this.flagSprite.visible = false;
  }

  checkPlayersEntry() {
    if (!this.tile) return;
    
    // Sprawdzamy, ilu aktywnych workerów (Top 10) stoi DOKŁADNIE na tym polu
    const workersOnTile = this.workerManager.entries.filter(e => {
      // Sprawdzamy targetGridX / targetGridZ, żeby łapać w trakcie chodu
      const tx = e.targetGridX !== undefined ? e.targetGridX : e.gridX;
      const tz = e.targetGridZ !== undefined ? e.targetGridZ : e.gridZ;
      return tx === this.tile.x && tz === this.tile.z && !e.isFainted;
    });

    if (workersOnTile.length >= 2) {
      // Start bitwy!
      const p1 = workersOnTile[0];
      const p2 = workersOnTile[1];
      
      const p1User = this.kickChat.assignments.workerToUser[p1.typeIndex]?.username || 'Gracz 1';
      const p2User = this.kickChat.assignments.workerToUser[p2.typeIndex]?.username || 'Gracz 2';

      this.players = [
        { typeIndex: p1.typeIndex, username: p1User, score: 0 },
        { typeIndex: p2.typeIndex, username: p2User, score: 0 }
      ];
      
      this.state = 'BATTLE';
      this.flagsGuessed = 0;
      
      // Obracamy ich twarzą do siebie
      const angleP1 = Math.atan2(p2.obj.position.x - p1.obj.position.x, p2.obj.position.z - p1.obj.position.z);
      p1.targetRotY = angleP1;
      p1.facingAngle = angleP1;
      p2.targetRotY = angleP1 + Math.PI;
      p2.facingAngle = angleP1 + Math.PI;
      
      // Animacja walki
      if (p1.interactAction) p1.interactAction.play();
      if (p2.interactAction) p2.interactAction.play();
      
      this.nextRound();
      this.announce(`Bitwa o flagi! ${p1User} vs ${p2User}! Wpisuj nazwę państwa na czacie! Kto pierwszy zdobędzie 3 pkt wygrywa!`);
    }
  }
  
  nextRound() {
    if (this.state !== 'BATTLE') return;

    // Losujemy nową flagę
    this.currentFlag = COUNTRY_CODES[Math.floor(Math.random() * COUNTRY_CODES.length)];
    this._stosujTeksturaFlagi(this.currentFlag);
  }

  /**
   * Ustawia teksture sprite'a flagi na podana flage (kod ISO), korzystajac z
   * cache'u modulowego zaladujTeksturaFlagi (patrz gora pliku). Uzywane
   * zarowno przez hosta (nextRound, decyzja) jak i widza (applySync, echo
   * decyzji hosta) - stad wspolna metoda.
   *
   * Chroni przed wyscigiem: jesli w trakcie asynchronicznej rasteryzacji
   * runda zdazy sie zmienic (kolejne wywolanie tej metody), starszy wynik
   * jest ignorowany i NIE nadpisuje nowszej flagi.
   */
  _stosujTeksturaFlagi(kod) {
    this._flagReqId += 1;
    const mojeId = this._flagReqId;
    zaladujTeksturaFlagi(kod, this.renderer)
      .then((texture) => {
        if (mojeId !== this._flagReqId) return; // starsze zadanie, zdazylo sie juz zdezaktualizowac
        this.flagMaterial.map = texture;
        this.flagMaterial.needsUpdate = true;
        this.flagSprite.visible = true;
      })
      .catch((err) => {
        console.error(`[flagi] Blad ladowania tekstury flagi ${kod}:`, err);
      });
  }

  onChatMessage(username, content) {
    // Ocena odpowiedzi to decyzja - tylko host jej dokonuje (patrz komentarz
    // przy isHost w setContext). Widz i tak dostanie wynik przez applySync.
    if (!this.isHost) return;
    if (this.state !== 'BATTLE' || !this.currentFlag) return;
    
    const player = this.players.find(p => p.username.toLowerCase() === username.toLowerCase());
    if (!player) return; // Tylko gracze na polu mogą odpowiadać
    
    const ans = normalizeCountryName(content);
    const expected = normalizeCountryName(COUNTRIES[this.currentFlag]);
    
    if (ans === expected || ans.includes(expected)) {
      player.score += 1;
      this.flagsGuessed += 1;
      const properName = COUNTRIES[this.currentFlag];
      this.currentFlag = null; // blokada by nie nabić 2x na 1 wiadomości
      
      this.announce(`${username} zgaduje poprawnie: ${properName}! (Punkty: ${player.score})`);
      
      if (player.score >= 3) {
        this.endBattle(player);
      } else {
        setTimeout(() => this.nextRound(), 1000);
      }
    }
  }
  
  endBattle(winnerPlayer) {
    this.state = 'REWARD';
    this.rewardTimer = 0;
    this._lastRewardTime = 0;
    this.winner = winnerPlayer;
    this.flagSprite.visible = false;
    
    // Zatrzymujemy animacje walki
    this.players.forEach(p => {
      const w = this.workerManager.getWorkerType(p.typeIndex);
      if (w && w.interactAction) w.interactAction.stop();
    });
    
    // Przegranego wyrzucamy na losowe wolne pole (lub sąsiednie)
    const loser = this.players.find(p => p.typeIndex !== winnerPlayer.typeIndex);
    if (loser) {
      const lw = this.workerManager.getWorkerType(loser.typeIndex);
      if (lw) {
         // Teleportujemy obok by go "wyrzucić" z pola chwały
         let kickX = this.tile.x + (Math.random() > 0.5 ? 1 : -1);
         let kickZ = this.tile.z + (Math.random() > 0.5 ? 1 : -1);
         if (kickX < -3) kickX = -2; if (kickX > 3) kickX = 2;
         if (kickZ < -3) kickZ = -2; if (kickZ > 3) kickZ = 2;
         if (kickX === 0 && kickZ === 0) kickX = 1; // Zabezpieczenie przed bankomatem
         
         lw.gridX = kickX;
         lw.gridZ = kickZ;
         lw.targetGridX = kickX;
         lw.targetGridZ = kickZ;
         lw.obj.position.set(kickX, 0, kickZ);
         lw.startPos.set(kickX, 0, kickZ);
         lw.targetPos.set(kickX, 0, kickZ);
      }
    }

    this.announce(`🎉 ${winnerPlayer.username} WYGRYWA! Przez 30 sekund dostaje 2 zł/s pasywnie, stojąc na polu chwały!`);
  }

  reset() {
    this.state = 'IDLE';
    this.timer = 0;
    this.tile = null;
    this.players = [];
    this.currentFlag = null;
    this._loadedFlag = null;
    this.winner = null;
    this.highlightMesh.visible = false;
    this.flagSprite.visible = false;
  }

  /** Wycinek stanu wysylany widzom (patrz zbierzStan w main.js). Tylko host go czyta z realnego stanu - widz go dostaje. */
  getSyncState() {
    return {
      state: this.state,
      tile: this.tile,
      players: this.players,
      currentFlag: this.currentFlag,
      flagsGuessed: this.flagsGuessed,
      winner: this.winner,
      rewardTimer: this.rewardTimer,
    };
  }

  /**
   * Wyrownuje lokalny (wizualny) stan minigry u widza do tego, co przyslal
   * host. Host tego nie woluje - sam prowadzi minigre naprawde (patrz tick/
   * onChatMessage powyzej), a to by ja nadpisalo wlasnym echem.
   */
  applySync(s) {
    if (this.isHost) return;
    if (!s || s.state === 'IDLE' || !s.tile) {
      if (this.state !== 'IDLE') this.reset();
      return;
    }

    const prevState = this.state;
    this.state = s.state;
    this.tile = s.tile;
    this.players = Array.isArray(s.players) ? s.players : [];
    this.flagsGuessed = s.flagsGuessed || 0;
    this.winner = s.winner || null;
    this.rewardTimer = s.rewardTimer || 0;
    this.currentFlag = s.currentFlag || null;

    // Animacja walki - host ja odpala/zatrzymuje w checkPlayersEntry/endBattle,
    // tu odtwarzamy to samo po zmianie stanu (opoznienie jak przy kazdym innym
    // snapshocie, max ok. 2 s - patrz interwal wyslijSnapshot w main.js).
    if (this.state === 'BATTLE' && prevState !== 'BATTLE') {
      this.players.forEach((p) => {
        const w = this.workerManager && this.workerManager.getWorkerType(p.typeIndex);
        if (w && w.interactAction) w.interactAction.play();
      });
    } else if (prevState === 'BATTLE' && this.state !== 'BATTLE') {
      this.players.forEach((p) => {
        const w = this.workerManager && this.workerManager.getWorkerType(p.typeIndex);
        if (w && w.interactAction) w.interactAction.stop();
      });
    }

    this.highlightMesh.position.x = this.tile.x;
    this.highlightMesh.position.z = this.tile.z;
    this.highlightMesh.visible = true;
    this.flagSprite.position.set(this.tile.x, 2.5, this.tile.z);

    if (this.state === 'BATTLE' && this.currentFlag) {
      if (this.currentFlag !== this._loadedFlag) {
        this._loadedFlag = this.currentFlag;
        this._stosujTeksturaFlagi(this.currentFlag);
      }
    } else {
      // WAITING (jeszcze bez flagi) albo REWARD (flaga juz schowana u hosta).
      this.flagSprite.visible = false;
    }
  }

  announce(text) {
    // Proste użycie istniejącego UI
    const messagesEl = document.getElementById('kick-messages');
    if (messagesEl) {
      const div = document.createElement('div');
      div.className = 'chat-message';
      div.innerHTML = `<strong style="color: gold">[Bitwa o flagi]</strong> <span>${text}</span>`;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    try {
      this.onAnnounce(text);
    } catch (err) {
      console.warn('[flagi] Blad w onAnnounce:', err);
    }
  }
}
