import * as THREE from 'three';
import { loadDungeon } from './assets.js';
import { showTopAnnouncement } from './vanessa.js';
import { audio } from './audio.js';

const SPAWN_INTERVAL = 10; // sekundy do pojawienia się kolejnej monety
const LIFETIME = 25; // maksymalny czas obecności monety na planszy, jeśli nikt do niej nie dobiegnie
const COIN_REWARD = 25; // nagroda 25 zł dla pierwszego gracza, który dobiegnie

// Odstep miedzy przebudowami geometrii lucznego znacznika czasu (patrz
// _updateMarkerArc). Przebudowa geometrii co klatke (144x/s przy 144 fps) to
// czysta strata - oko i tak nie odrozni zwijania sie co 0.1s od co klatke,
// a rebuild raz na ARC_REBUILD_INTERVAL sekund eliminuje ~143 alokacje/s
// bez zadnej zauwazalnej roznicy w plynnosci animacji.
const ARC_REBUILD_INTERVAL = 0.1;

/**
 * Złota moneta na planszy gry:
 * - Pojawia się co 10 sekund na losowym, wolnym polu siatki areny (x: -3..3, z: -3..3).
 * - Nie jest klikana myszką - pierwsza postać gracza z Top 10, która do niej dobiegnie, zgarnia 25 zł.
 * - Po zebraniu moneta natychmiast znika, a za 10 sekund pojawia się kolejna.
 */
export class GoldenCoinManager {
  constructor(scene) {
    this.scene = scene;
    this.template = null;
    this.mesh = null;

    this.gridX = null;
    this.gridZ = null;

    this.timeToSpawn = SPAWN_INTERVAL; // pierwsza moneta po 10 sekundach
    this.life = 0;
    this.bobT = 0;
    this._arcRebuildAcc = 0;
    this._lastArcLength = -1;

    this.workerManager = null;
    this.kickChat = null;
    this.economy = null;
    this.coinPool = null;
    this.projectAndFloat = null;
    this.save = null;
  }

  setContext({ workerManager, kickChat, economy, coinPool, projectAndFloat, save }) {
    this.workerManager = workerManager || this.workerManager;
    this.kickChat = kickChat || this.kickChat;
    this.economy = economy || this.economy;
    this.coinPool = coinPool || this.coinPool;
    this.projectAndFloat = projectAndFloat || this.projectAndFloat;
    this.save = save || this.save;
  }

  async init() {
    const gltf = await loadDungeon('coin');
    this.template = gltf.scene;
  }

  _pickRandomTile() {
    const occupied = new Set();
    occupied.add('0,0'); // Bankomat w centrum

    if (this.workerManager && this.workerManager.entries) {
      for (const entry of this.workerManager.entries) {
        if (!entry) continue;
        occupied.add(`${entry.gridX},${entry.gridZ}`);
        if (entry.targetGridX !== undefined && entry.targetGridZ !== undefined) {
          occupied.add(`${entry.targetGridX},${entry.targetGridZ}`);
        }
      }
    }

    const available = [];
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        const key = `${x},${z}`;
        if (!occupied.has(key)) {
          available.push({ x, z });
        }
      }
    }

    if (available.length === 0) {
      return { x: 2, z: 2 };
    }

    const idx = Math.floor(Math.random() * available.length);
    return available[idx];
  }

  _spawn(forcedTile = null) {
    if (!this.template || this.mesh) return;

    const tile = forcedTile || this._pickRandomTile();
    this.gridX = tile.x;
    this.gridZ = tile.z;

    const mesh = this.template.clone(true);
    mesh.scale.setScalar(0.72);
    mesh.traverse((node) => {
      if (node.isMesh && node.material) {
        const wasArray = Array.isArray(node.material);
        const mats = wasArray ? node.material : [node.material];
        const gold = mats.map((m) => {
          const clone = m.clone();
          clone.color = new THREE.Color(0xffe040);
          clone.emissive = new THREE.Color(0xff9900);
          clone.emissiveIntensity = 0.65;
          return clone;
        });
        node.material = wasArray ? gold : gold[0];
        node.castShadow = true;
      }
    });

    mesh.position.set(tile.x, 0.45, tile.z);
    this.scene.add(mesh);
    this.mesh = mesh;

    // Grupa wskaźnika podłogowego pod monetą (y = 0.048 - całkowita eliminacja Z-fightingu z podłogą i siatką 0.028)
    const markerGroup = new THREE.Group();
    markerGroup.rotation.x = -Math.PI / 2;
    markerGroup.position.set(tile.x, 0.048, tile.z);

    // 1. Tło pełnego okręgu (faint track pokazujący pełny czas)
    const bgGeo = new THREE.RingGeometry(0.22, 0.42, 40);
    const bgMat = new THREE.MeshBasicMaterial({
      color: 0x5a4800,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    const bgMesh = new THREE.Mesh(bgGeo, bgMat);
    markerGroup.add(bgMesh);
    this.markerBg = bgMesh;

    // 2. Aktywny okrąg czasu zwijający się w miarę upływu sekund (radial countdown arc)
    const arcGeo = new THREE.RingGeometry(0.22, 0.42, 40, 1, -Math.PI / 2, Math.PI * 2);
    const arcMat = new THREE.MeshBasicMaterial({
      color: 0xffd700,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      side: THREE.DoubleSide,
    });
    const arcMesh = new THREE.Mesh(arcGeo, arcMat);
    markerGroup.add(arcMesh);
    this.markerArc = arcMesh;

    this.scene.add(markerGroup);
    this.markerGroup = markerGroup;

    this.life = LIFETIME;
    this.bobT = 0;
    this._arcRebuildAcc = 0;
    this._lastArcLength = -1;

    audio.play('moneta-spawn');
    showTopAnnouncement(
      '🪙 ZŁOTA MONETA!',
      `Pojawiła się na polu <strong>[${tile.x}, ${tile.z}]</strong>! Kto pierwszy dobiegnie, zgarnia <strong>${COIN_REWARD} zł</strong>!`,
      2600
    );
  }

  _updateMarkerArc(progress, delta) {
    if (!this.markerArc || !this.markerGroup) return;

    // Przebudowa geometrii lucznego znacznika NIE leci co klatke - tylko raz
    // na ARC_REBUILD_INTERVAL sekund (patrz komentarz przy stalej). Reszta
    // efektow (puls, kolor) nadal aktualizuje sie co klatke - to tanie zmiany
    // materialu/transformacji, zero alokacji.
    this._arcRebuildAcc += delta || 0;
    if (this._arcRebuildAcc >= ARC_REBUILD_INTERVAL || this._lastArcLength < 0) {
      this._arcRebuildAcc = 0;
      // Długość łuku w radianach - od pełnego koła (2π) do zera
      const arcLength = Math.max(0.001, progress * Math.PI * 2);
      this._lastArcLength = arcLength;
      if (this.markerArc.geometry) {
        this.markerArc.geometry.dispose();
      }
      this.markerArc.geometry = new THREE.RingGeometry(0.22, 0.42, 40, 1, -Math.PI / 2, arcLength);
    }

    // Subtelne pulsowanie rozmiaru
    const pulse = 0.96 + 0.04 * Math.sin(this.bobT * 5);
    this.markerGroup.scale.set(pulse, pulse, 1);

    // Ostrzegawcza zmiana koloru w ostatnich 30% czasu (przejście od złota do pomarańczowo-czerwonego)
    if (progress < 0.3) {
      const alertT = (0.3 - progress) / 0.3; // 0..1
      this.markerArc.material.color.setRGB(1.0, 0.84 - alertT * 0.65, 0.0);
      this.markerArc.material.opacity = 0.65 + Math.sin(this.bobT * 12) * 0.3;
    } else {
      this.markerArc.material.color.setHex(0xffd700);
      this.markerArc.material.opacity = 0.85;
    }
  }

  _despawn() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh = null;
    }
    if (this.markerGroup) {
      this.scene.remove(this.markerGroup);
      if (this.markerBg) {
        if (this.markerBg.geometry) this.markerBg.geometry.dispose();
        if (this.markerBg.material) this.markerBg.material.dispose();
        this.markerBg = null;
      }
      if (this.markerArc) {
        if (this.markerArc.geometry) this.markerArc.geometry.dispose();
        if (this.markerArc.material) this.markerArc.material.dispose();
        this.markerArc = null;
      }
      this.markerGroup = null;
    }
    this.gridX = null;
    this.gridZ = null;
    this.timeToSpawn = SPAWN_INTERVAL;
  }

  _collectByWorker(entry) {
    if (!this.mesh) return;

    const workerIndex = Number(entry.typeIndex);
    const user = this.kickChat ? this.kickChat.getUserForWorker(workerIndex) : null;
    const username = user ? user.username : `Gracz_${workerIndex + 1}`;
    const userColor = user ? user.color : '#53fc18';
    const pos = this.mesh.position.clone();

    // 1. Dopisanie 25 zł do stanu gracza i do ekonomii gry. countsAsClick=false -
    // zebranie monety to NIE jest komenda "klik" i nie moze zawyzac licznika
    // klikniec widza w rankingu (patrz kick.js recordEarned).
    if (this.kickChat && user && user.username) {
      this.kickChat.recordEarned(username, COIN_REWARD, userColor, false);
    }
    if (this.economy) {
      this.economy.addMoney(COIN_REWARD);
    }
    if (this.save) {
      this.save();
    }

    audio.play('moneta-zebrana');

    // 2. Efekt wybuchu monet Three.js
    if (this.coinPool) {
      this.coinPool.burst(pos, COIN_REWARD);
    }

    // 3. Pływający napis nad postacią
    if (this.projectAndFloat) {
      const textPos = pos.clone().add(new THREE.Vector3(0, 0.8, 0));
      this.projectAndFloat(textPos, `+${COIN_REWARD} zł! (@${username})`, { gold: true });
    }

    // 4. Baner powiadomienia
    showTopAnnouncement(
      '🪙 ZŁOTA MONETA ZEBRANA!',
      `<strong>@${username}</strong> dobiegł pierwszy do monety i zgarnia <strong>${COIN_REWARD} zł</strong>!`,
      2500
    );

    // 5. Usunięcie monety - kolejna za 10 sekund
    this._despawn();
  }

  /** Publiczna metoda do natychmiastowego zrespienia monety (np. do testów) */
  spawn(tile = null) {
    this._despawn();
    this._spawn(tile);
  }

  reset() {
    this._despawn();
    this.timeToSpawn = SPAWN_INTERVAL;
  }

  update(delta) {
    if (this.mesh) {
      this.bobT += delta;
      this.mesh.position.y = 0.45 + Math.sin(this.bobT * 4) * 0.08;
      this.mesh.rotation.y += delta * 2.8;

      this.life -= delta;
      const progress = Math.max(0, Math.min(1, this.life / LIFETIME));
      this._updateMarkerArc(progress, delta);

      // Sprawdzenie czy któryś z aktywnych graczy dobiegł na pole monety
      if (this.workerManager && this.workerManager.entries) {
        for (const entry of this.workerManager.entries) {
          if (!entry || !entry.obj || entry.isFainted) continue;

          const isAtTile = entry.gridX === this.gridX && entry.gridZ === this.gridZ;
          const isSteppingToTile = entry.targetGridX === this.gridX && entry.targetGridZ === this.gridZ;
          const dist = entry.obj.position.distanceTo(this.mesh.position);

          if (isAtTile || (isSteppingToTile && dist < 0.65)) {
            this._collectByWorker(entry);
            return;
          }
        }
      }

      if (this.life <= 0) {
        this._despawn();
      }
      return;
    }

    this.timeToSpawn -= delta;
    if (this.timeToSpawn <= 0) {
      this._spawn();
    }
  }
}
