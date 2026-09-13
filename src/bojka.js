import * as THREE from 'three';
import { mulberry32, hashString } from './rng.js';
import { audio } from './audio.js';

// Wspolny modul "bojki" (bijatyki) uzywany przez OBIE minigry na siatce
// (flagbattle.js i tlumaczenia.js) - zamiast kopiowac ta sama logike walki i
// chmury kurzu do obu plikow (tak jak swiadomie skopiowano cala reszte
// mechaniki minigry - patrz komentarz na gorze tlumaczenia.js), ten JEDEN
// kawalek jest naprawde wspoldzielony: jest czysto KOSMETYCZNY (nie wplywa na
// wynik/synchronizacje rozgrywki), wiec ryzyko regresji przy dzieleniu kodu
// jest tu dużo nizsze niz przy stanie minigry.
//
// Zasada synchronizacji host/widz: sama DECYZJA "czy bojka trwa" wychodzi z
// juz zsynchronizowanego stanu (state==='BATTLE' + players, patrz wywolania w
// flagbattle.js/tlumaczenia.js) - zero nowych zdarzen sieciowych. Konkretny
// RYTM ciosow/kurzu jest lokalna, kosmetyczna animacja (jak pulsowanie
// koloru markera w tick() obu minigier, ktore tez nie jest synchronizowane
// klatka po klatce) - seedowana na start bitwy, zeby kazda postac miala swoj
// wlasny, nieregularny rytm zamiast identycznego metronomu, ale bez potrzeby
// przesylania "ktory to byl cios" przez siec (w odroznieniu od triggerAttack
// po poprawnej odpowiedzi, ktore JEST wyprowadzone z synchronizowanego
// flagsGuessed/wordsGuessed - to zostaje bez zmian, patrz onChatMessage/
// applySync w obu plikach).

const OFFSET_OD_SRODKA = 0.22; // jak daleko kazdy z walczacych odsuwa sie od srodka pola
const PROMIEN_CHMURY = 0.46; // < 0.5 (polowa kafla) - nigdy nie wychodzi na sasiednie pola

const KLIPY_WALKI = [
  'attack-melee-right',
  'attack-melee-left',
  'attack-kick-right',
  'attack-kick-left',
  'attack-melee-right',
  'attack-melee-left',
  'attack-kick-right',
  'attack-kick-left',
  'jump', // od czasu do czasu "unik" zamiast ciosu - urozmaica rytm
];

// ============ Tekstury (generowane raz na modul, cache'owane na cala sesje) ============
// Zgodnie z wymaganiem: "Tekstury generuj raz i cache'uj" - te canvasy nigdy
// nie sa disposowane (sa tanie, 96x96/128x128, i wspoldzielone przez KAZDA
// bojke w calej grze - jedna FlagBattleManager i jedna TlumaczeniaManager,
// kazda ma wlasna instancje Bojka, ale obie czerpia z tych samych tekstur).

let _dustTexture = null;
function getDustTexture() {
  if (_dustTexture) return _dustTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;

  // Miekkie bialo-szare wypelnienie (gradient promieniowy)
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.48);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.6, 'rgba(236,232,224,0.95)');
  grad.addColorStop(0.85, 'rgba(205,198,186,0.7)');
  grad.addColorStop(1, 'rgba(205,198,186,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.48, 0, Math.PI * 2);
  ctx.fill();

  // Kreskowkowy kontur - kilka nakladajacych sie "klebow" konturu, zamiast
  // idealnego kola, zeby wygladalo jak rysowana chmura bojki, nie kula.
  ctx.strokeStyle = 'rgba(95,82,70,0.9)';
  ctx.lineWidth = 5;
  const kleby = 6;
  ctx.beginPath();
  for (let i = 0; i < kleby; i++) {
    const ang = (i / kleby) * Math.PI * 2;
    const r = size * 0.36;
    const kx = cx + Math.cos(ang) * r;
    const ky = cy + Math.sin(ang) * r;
    const kr = size * 0.16;
    ctx.moveTo(kx + kr, ky);
    ctx.arc(kx, ky, kr, 0, Math.PI * 2);
  }
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  _dustTexture = texture;
  return texture;
}

const _emojiTextureCache = new Map();
function getEmojiTexture(emoji) {
  if (_emojiTextureCache.has(emoji)) return _emojiTextureCache.get(emoji);
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(size * 0.72)}px "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.fillText(emoji, size / 2, size / 2 + size * 0.04);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  _emojiTextureCache.set(emoji, texture);
  return texture;
}

// Male "rączki/nóżki" wystające chwilowo z chmury - proste kapsulowe ksztalty
// (nie prawdziwe posta cie), rysowane raz i cache'owane jak reszta tekstur.
let _limbTexture = null;
function getLimbTexture() {
  if (_limbTexture) return _limbTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size * 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e8c39e';
  ctx.strokeStyle = '#5a3c28';
  ctx.lineWidth = 4;
  const w = size * 0.5;
  const x0 = (size - w) / 2;
  ctx.beginPath();
  ctx.moveTo(x0, size * 1.9);
  ctx.lineTo(x0, size * 0.5);
  ctx.arc(size / 2, size * 0.5, w / 2, Math.PI, 0);
  ctx.lineTo(x0 + w, size * 1.9);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  _limbTexture = texture;
  return texture;
}

/**
 * Jedna instancja Bojka = jedno "pole bitwy" jednej minigry (FlagBattleManager
 * lub TlumaczeniaManager tworzy dokladnie jedna, w konstruktorze, i trzyma ja
 * przez cale zycie karty). Pula sprite'ow (this.puffs/this.sparkles/this.limbs)
 * jest budowana LENIWIE przy pierwszym start() i NIGDY nie jest usuwana ze
 * sceny/disposowana pomiedzy bitwami - kolejne bitwy tylko wlaczaja/wylaczaja
 * widocznosc i resetuja parametry animacji. To gwarantuje zerowy przyrost
 * liczby obiektow w scenie/draw calls po kazdej kolejnej bitwie (patrz
 * wymaganie "zero wyciekow (dispose przy koncu bitwy, sprite'y z puli)").
 */
export class Bojka {
  constructor(scene) {
    this.scene = scene;
    this.active = false;
    this._built = false;
    this._t = 0;

    this.group = new THREE.Group();
    this.group.visible = false;
    this.scene.add(this.group);

    this.puffs = [];
    this.sparkles = [];
    this.limbs = [];
    this.fighters = []; // [{ typeIndex, rng, sign, timer, bobPhase }]
    this.axisAngle = 0;
  }

  _ensureBuilt() {
    if (this._built) return;
    this._built = true;

    const dustTex = getDustTexture();
    const LICZBA_KLEBOW = 7;
    for (let i = 0; i < LICZBA_KLEBOW; i++) {
      const mat = new THREE.SpriteMaterial({
        map: dustTex,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        opacity: 0.7,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.renderOrder = 15;
      sprite.userData.stopa = i < 2; // pierwsze dwa kleby graja role "kurzu spod stop" - nizej i plaskie
      this.group.add(sprite);
      this.puffs.push({ sprite });
    }

    const emojis = ['💥', '⭐', '💥', '⭐'];
    for (const em of emojis) {
      const mat = new THREE.SpriteMaterial({
        map: getEmojiTexture(em),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.renderOrder = 20;
      this.group.add(sprite);
      this.sparkles.push({ sprite, active: false, timer: 0.4, life: 0, duration: 0.4 });
    }

    const limbTex = getLimbTexture();
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.SpriteMaterial({
        map: limbTex,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(0.22, 0.44, 1);
      sprite.renderOrder = 18;
      this.group.add(sprite);
      this.limbs.push({ sprite, active: false, timer: 0.8 + i * 0.5, life: 0, duration: 0.3 });
    }
  }

  /**
   * Rozpoczyna bijatyke na danym polu miedzy dokladnie dwoma graczami
   * (players[0], players[1] - dodatkowi ignorowani, minigry maja zawsze
   * dokladnie 2 graczy). Wolane ZARÓWNO przez hosta (wejscie w BATTLE), JAK
   * I przez widza (applySync, przejscie stanu na BATTLE) - patrz wywolania w
   * flagbattle.js/tlumaczenia.js. `seedKey` powinien zawierac battleId (juz
   * zsynchronizowany), zeby efekt byl powtarzalny w obrebie jednej bitwy, choc
   * (patrz komentarz na gorze pliku) nie musi byc identyczny co do klatki
   * miedzy hostem a widzem - to czysta kosmetyka.
   */
  start(tile, players, seedKey) {
    this._ensureBuilt();
    if (!tile || !Array.isArray(players) || players.length < 2) return;

    this.active = true;
    this._t = 0;
    this.group.visible = true;
    this.group.position.set(tile.x, 0, tile.z);

    const rngOs = mulberry32(hashString(`${seedKey}:os`));
    this.axisAngle = rngOs() * Math.PI * 2;

    this.fighters = players.slice(0, 2).map((p, i) => {
      const rng = mulberry32(hashString(`${seedKey}:${p.typeIndex}:${p.username || ''}`));
      return {
        typeIndex: p.typeIndex,
        rng,
        sign: i === 0 ? -1 : 1,
        timer: 0.25 + rng() * 0.5,
        bobPhase: rng() * Math.PI * 2,
        bobSpeed: 2.2 + rng() * 1.4,
      };
    });

    for (const p of this.puffs) {
      const rng = mulberry32(hashString(`${seedKey}:puff:${this.puffs.indexOf(p)}`));
      p.phase = rng() * Math.PI * 2;
      p.speed = 0.9 + rng() * 0.9;
      p.angle0 = rng() * Math.PI * 2;
      p.baseRadius = p.sprite.userData.stopa ? (0.18 + rng() * 0.08) : (0.26 + rng() * 0.16);
      p.baseY = p.sprite.userData.stopa ? (0.03 + rng() * 0.04) : (0.32 + rng() * 0.35);
      p.baseScale = p.sprite.userData.stopa ? (0.32 + rng() * 0.1) : (0.5 + rng() * 0.22);
    }
    for (const s of this.sparkles) {
      s.active = false;
      s.timer = 0.3 + Math.random() * 1.2;
      s.sprite.material.opacity = 0;
    }
    for (const l of this.limbs) {
      l.active = false;
      l.timer = 0.5 + Math.random() * 1.0;
      l.sprite.material.opacity = 0;
    }
  }

  /** Wolane co klatke (host i widz, niezaleznie) - patrz tick() obu minigier. No-op, gdy bojka nieaktywna. */
  update(dt, workerManager) {
    if (!this.active) return;
    this._t += dt;

    this._updateChmura(dt);
    this._updateWalke(dt, workerManager);
  }

  _updateChmura(dt) {
    for (const p of this.puffs) {
      const ang = p.angle0 + this._t * p.speed * 0.6;
      const r = p.baseRadius * (0.85 + 0.15 * Math.sin(this._t * p.speed + p.phase));
      const rClamped = Math.min(r, PROMIEN_CHMURY);
      p.sprite.position.set(
        Math.cos(ang) * rClamped,
        p.baseY + 0.06 * Math.sin(this._t * 1.6 + p.phase),
        Math.sin(ang) * rClamped,
      );
      const puls = p.baseScale * (0.9 + 0.15 * Math.sin(this._t * 2.1 + p.phase));
      p.sprite.scale.set(puls, puls, 1);
      p.sprite.material.rotation += dt * 0.5 * (p.phase > Math.PI ? 1 : -1);
      p.sprite.material.opacity = 0.8 + 0.12 * Math.sin(this._t * 1.7 + p.phase);
    }

    for (const s of this.sparkles) {
      s.timer -= dt;
      if (!s.active && s.timer <= 0) {
        s.active = true;
        s.life = 0;
        s.duration = 0.35 + Math.random() * 0.2;
        const ang = Math.random() * Math.PI * 2;
        const r = Math.random() * PROMIEN_CHMURY * 0.8;
        s.sprite.position.set(Math.cos(ang) * r, 0.45 + Math.random() * 0.5, Math.sin(ang) * r);
      }
      if (s.active) {
        s.life += dt;
        const t = Math.min(1, s.life / s.duration);
        s.sprite.material.opacity = t < 0.3 ? t / 0.3 : Math.max(0, 1 - (t - 0.3) / 0.7);
        const sc = 0.25 + t * 0.4;
        s.sprite.scale.set(sc, sc, 1);
        if (t >= 1) {
          s.active = false;
          s.timer = 0.7 + Math.random() * 1.3;
          s.sprite.material.opacity = 0;
        }
      }
    }

    for (const l of this.limbs) {
      l.timer -= dt;
      if (!l.active && l.timer <= 0) {
        l.active = true;
        l.life = 0;
        l.duration = 0.25 + Math.random() * 0.15;
        const bok = Math.random() > 0.5 ? 1 : -1;
        l.sprite.position.set(bok * (PROMIEN_CHMURY * 0.6), 0.15 + Math.random() * 0.3, (Math.random() - 0.5) * 0.3);
        l.sprite.material.rotation = (Math.random() - 0.5) * 0.6;
      }
      if (l.active) {
        l.life += dt;
        const t = Math.min(1, l.life / l.duration);
        l.sprite.material.opacity = t < 0.4 ? t / 0.4 : Math.max(0, 1 - (t - 0.4) / 0.6);
        if (t >= 1) {
          l.active = false;
          l.timer = 1.0 + Math.random() * 1.8;
          l.sprite.material.opacity = 0;
        }
      }
    }
  }

  _updateWalke(dt, workerManager) {
    if (!workerManager || this.fighters.length < 2) return;
    const dirX = Math.sin(this.axisAngle);
    const dirZ = Math.cos(this.axisAngle);
    const perpX = Math.sin(this.axisAngle + Math.PI / 2);
    const perpZ = Math.cos(this.axisAngle + Math.PI / 2);

    const entries = this.fighters.map((f) => ({ f, entry: workerManager.getWorkerType(f.typeIndex) }));

    // Pozycje obu walczacych sa liczone NAJPIERW (w jednej petli), a dopiero
    // POTEM kazdy z nich obraca sie w strone JUZ POLICZONEJ pozycji tego
    // drugiego - inaczej ten drugi wciaz mialby pozycje sprzed tej klatki.
    for (const { f, entry } of entries) {
      if (!entry || !entry.obj || entry.isFainted) continue;
      const bob = Math.sin(this._t * f.bobSpeed + f.bobPhase) * 0.05;
      const hop = Math.max(0, Math.sin(this._t * f.bobSpeed * 0.5 + f.bobPhase)) * 0.05;
      const px = this.group.position.x + dirX * (OFFSET_OD_SRODKA * f.sign) + perpX * bob;
      const pz = this.group.position.z + dirZ * (OFFSET_OD_SRODKA * f.sign) + perpZ * bob;
      entry.obj.position.set(px, hop, pz);
    }

    for (let i = 0; i < entries.length; i++) {
      const { f, entry } = entries[i];
      if (!entry || !entry.obj || entry.isFainted) continue;
      const inny = entries[i === 0 ? 1 : 0];
      if (inny && inny.entry && inny.entry.obj && !inny.entry.isFainted) {
        const kierunek = Math.atan2(
          inny.entry.obj.position.x - entry.obj.position.x,
          inny.entry.obj.position.z - entry.obj.position.z,
        );
        entry.obj.rotation.y = kierunek;
        entry.facingAngle = kierunek;
      }

      f.timer -= dt;
      if (f.timer <= 0 && !entry.isMoving) {
        const klip = KLIPY_WALKI[Math.floor(f.rng() * KLIPY_WALKI.length)];
        const poszlo = workerManager.triggerAttack(entry, klip);
        f.timer = 0.55 + f.rng() * 1.0; // nieregularny rytm - roznica na kazdej postaci (seed z rundy+nicku)
        if (poszlo && klip !== 'jump' && f.rng() < 0.5) {
          audio.play('boss-trafienie');
        }
      }
    }
  }

  /**
   * Konczy bijatyke - chowa chmure/sprite'y (bez dispose, patrz komentarz
   * przy klasie) i odstawia obu walczacych DOKLADNIE na srodek ich wlasnego
   * kafla (gridX/gridZ - to wciaz TO SAMO pole, wiec to nie jest teleport,
   * tylko zdjecie odsuniecia ±OFFSET_OD_SRODKA wprowadzonego przez bojke).
   * Nie ingerujemy w ewentualny wciaz trwajacy klip ataku (LoopOnce,
   * clampWhenFinished) - dokonczy sie i sam wroci do idle przez istniejacy
   * listener 'finished' w workers.js (wrocDoIdle), dokladnie jak kazdy inny
   * triggerAttack w grze.
   */
  stop(workerManager) {
    if (!this.active) return;
    this.active = false;
    this.group.visible = false;

    for (const f of this.fighters) {
      const entry = workerManager && workerManager.getWorkerType(f.typeIndex);
      if (!entry || !entry.obj) continue;
      entry.obj.position.set(entry.gridX, 0, entry.gridZ);
      entry.obj.rotation.y = entry.facingAngle;
      entry.startPos.set(entry.gridX, 0, entry.gridZ);
      entry.targetPos.set(entry.gridX, 0, entry.gridZ);
    }
    this.fighters = [];
  }
}
