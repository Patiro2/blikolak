import * as THREE from 'three';
import { loadBlaster } from './assets.js';

// Efekty ataków obszarowych bossa: znaczniki pól, pociski lecące po łuku,
// rakiety spadające z góry, kałuże i dym. Trzymane w osobnym module, bo
// boss.js odpowiada za logikę walki, a nie za grafikę pocisków.
//
// Cała mechanika jest POLOWA: atak zawsze celuje w konkretne pole siatki 7x7
// areny (x, z w zakresie -3..3), pole jest z wyprzedzeniem oznaczane
// znacznikiem, a skutek dotyka tego, kto w chwili uderzenia na nim stoi.
// Dzięki temu o wyniku decyduje to, gdzie gracz stoi, a nie losowanie.

// Znaczniki leza ponizej wskaznika zlotej monety (0.048), ale powyzej
// neonowej siatki areny (0.035) - patrz scene.js i goldcoin.js.
const MARKER_Y = 0.042;

/** Tworzy plaski pierscien znacznika pola wraz z wypelnieniem. */
function makeMarker(kolor) {
  const grupa = new THREE.Group();
  grupa.rotation.x = -Math.PI / 2;

  const wspolne = {
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  };

  const pierscienGeo = new THREE.RingGeometry(0.34, 0.47, 36);
  const pierscienMat = new THREE.MeshBasicMaterial({ color: kolor, opacity: 0.95, ...wspolne });
  const pierscien = new THREE.Mesh(pierscienGeo, pierscienMat);
  grupa.add(pierscien);

  const wypelnienieGeo = new THREE.CircleGeometry(0.34, 32);
  const wypelnienieMat = new THREE.MeshBasicMaterial({ color: kolor, opacity: 0.18, ...wspolne });
  const wypelnienie = new THREE.Mesh(wypelnienieGeo, wypelnienieMat);
  grupa.add(wypelnienie);

  grupa.userData.pierscien = pierscien;
  grupa.userData.wypelnienie = wypelnienie;
  return grupa;
}

function usunObiekt(scene, obj) {
  if (!obj) return;
  scene.remove(obj);
  obj.traverse((n) => {
    if (!n.isMesh) return;
    if (n.geometry) n.geometry.dispose();
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    for (const m of mats) if (m) m.dispose();
  });
}

export class BossAttackFx {
  constructor(scene) {
    this.scene = scene;
    this.szablonRakieta = null;
    this.szablonDym = null;
    this.szablonBron = null;

    this.znaczniki = []; // { obj, zostalo, calosc, pulsuje }
    this.pociski = []; // { obj, start, cel, t, czas, wysokoscLuku, obrot, onImpact }
    this.zanikajace = []; // { obj, zostalo, calosc, rosnie, materialy }
  }

  async init() {
    // Modele z kenney_blaster-kit (wlasny colormap - patrz assets/blaster/).
    // Brak modelu nie moze wywalic walki, stad tolerancja na blad ladowania.
    try {
      const [rakieta, dym, bron] = await Promise.all([
        loadBlaster('grenade-a'),
        loadBlaster('smoke'),
        loadBlaster('blaster-e'),
      ]);
      this.szablonRakieta = rakieta.scene;
      this.szablonDym = dym.scene;
      this.szablonBron = bron.scene;
    } catch (err) {
      console.warn('[bossattack] Nie udalo sie zaladowac modeli ataku:', err);
    }
  }

  /** Kopia modelu broni bossa (wyrzutnik) do doczepienia do reki. */
  stworzBron() {
    if (!this.szablonBron) return null;
    const bron = this.szablonBron.clone(true);
    bron.traverse((n) => {
      if (n.isMesh) {
        n.castShadow = true;
        n.receiveShadow = false;
      }
    });
    return bron;
  }

  /**
   * Znacznik pola. `czas` to czas ostrzegania w sekundach; znacznik pulsuje i
   * gasnie razem z odliczaniem, wiec widac, ile zostalo do uderzenia.
   */
  oznaczPole(x, z, kolor, czas) {
    const obj = makeMarker(kolor);
    obj.position.set(x, MARKER_Y, z);
    this.scene.add(obj);
    const wpis = { obj, zostalo: czas, calosc: czas };
    this.znaczniki.push(wpis);
    return wpis;
  }

  usunZnacznik(wpis) {
    if (!wpis) return;
    const i = this.znaczniki.indexOf(wpis);
    if (i !== -1) this.znaczniki.splice(i, 1);
    usunObiekt(this.scene, wpis.obj);
  }

  /** Pocisk lecacy po luku z punktu A na srodek pola (x, z). */
  wystrzelPocisk(start, x, z, czas, onImpact) {
    const geo = new THREE.SphereGeometry(0.17, 14, 12);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x86c232,
      emissive: 0x2f5d10,
      emissiveIntensity: 0.8,
      roughness: 0.4,
    });
    const obj = new THREE.Mesh(geo, mat);
    obj.scale.set(1, 0.78, 1);
    obj.castShadow = true;
    obj.position.copy(start);
    this.scene.add(obj);
    this.pociski.push({
      obj,
      start: start.clone(),
      cel: new THREE.Vector3(x, 0.12, z),
      t: 0,
      czas,
      wysokoscLuku: 1.5,
      obrot: 6,
      onImpact,
    });
  }

  /** Rakieta spadajaca pionowo na pole (x, z). */
  zrzucRakiete(x, z, czas, onImpact) {
    let obj;
    if (this.szablonRakieta) {
      obj = this.szablonRakieta.clone(true);
      obj.scale.setScalar(1.8);
      // Glowica nosem w dol
      obj.rotation.x = Math.PI;
    } else {
      obj = new THREE.Mesh(
        new THREE.ConeGeometry(0.12, 0.4, 10),
        new THREE.MeshStandardMaterial({ color: 0xd23b2e, emissive: 0x4a0d08, emissiveIntensity: 0.7 }),
      );
      obj.rotation.x = Math.PI;
    }
    obj.traverse((n) => {
      if (n.isMesh) n.castShadow = true;
    });
    const start = new THREE.Vector3(x, 9, z);
    obj.position.copy(start);
    this.scene.add(obj);
    this.pociski.push({
      obj,
      start,
      cel: new THREE.Vector3(x, 0.14, z),
      t: 0,
      czas,
      wysokoscLuku: 0,
      obrot: 0,
      przyspieszenie: true,
      onImpact,
    });
  }

  /** Kaluza po trafieniu - lezy na polu i powoli znika. */
  rozlejKaluze(x, z, kolor, czas = 6) {
    const geo = new THREE.CircleGeometry(0.46, 28);
    const mat = new THREE.MeshBasicMaterial({
      color: kolor,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
      side: THREE.DoubleSide,
    });
    const obj = new THREE.Mesh(geo, mat);
    obj.rotation.x = -Math.PI / 2;
    obj.position.set(x, MARKER_Y + 0.002, z);
    this.scene.add(obj);
    this.zanikajace.push({ obj, zostalo: czas, calosc: czas, rosnie: false, materialy: [mat] });
  }

  /** Oblok dymu/wybuchu rosnacy i zanikajacy w miejscu uderzenia. */
  wybuch(x, z, czas = 1.1) {
    let obj;
    const materialy = [];
    if (this.szablonDym) {
      obj = this.szablonDym.clone(true);
      obj.traverse((n) => {
        if (n.isMesh && n.material) {
          const m = n.material.clone();
          m.transparent = true;
          m.depthWrite = false;
          n.material = m;
          materialy.push(m);
        }
      });
      obj.scale.setScalar(1.2);
    } else {
      const m = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.8, depthWrite: false });
      materialy.push(m);
      obj = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), m);
    }
    obj.position.set(x, 0.18, z);
    this.scene.add(obj);
    this.zanikajace.push({ obj, zostalo: czas, calosc: czas, rosnie: true, materialy });
  }

  update(delta) {
    // 1. Znaczniki - pulsowanie i odliczanie
    for (let i = this.znaczniki.length - 1; i >= 0; i--) {
      const z = this.znaczniki[i];
      z.zostalo -= delta;
      const post = Math.max(0, z.zostalo / z.calosc);
      const puls = 0.92 + 0.12 * Math.sin((1 - post) * 26);
      z.obj.scale.set(puls, puls, 1);
      const pierscien = z.obj.userData.pierscien;
      const wypelnienie = z.obj.userData.wypelnienie;
      if (pierscien) pierscien.material.opacity = 0.55 + 0.45 * Math.abs(Math.sin((1 - post) * 13));
      if (wypelnienie) wypelnienie.material.opacity = 0.12 + 0.26 * (1 - post);
      if (z.zostalo <= 0) {
        this.znaczniki.splice(i, 1);
        usunObiekt(this.scene, z.obj);
      }
    }

    // 2. Pociski i rakiety
    for (let i = this.pociski.length - 1; i >= 0; i--) {
      const p = this.pociski[i];
      p.t += delta / p.czas;
      const t = Math.min(1, p.t);
      // Rakieta przyspiesza (swobodny spadek), pocisk leci rownomiernie po luku
      const u = p.przyspieszenie ? t * t : t;
      p.obj.position.lerpVectors(p.start, p.cel, u);
      if (p.wysokoscLuku > 0) {
        p.obj.position.y += Math.sin(Math.PI * t) * p.wysokoscLuku;
      }
      if (p.obrot > 0) {
        p.obj.rotation.x += delta * p.obrot;
        p.obj.rotation.z += delta * p.obrot * 0.6;
      }
      if (t >= 1) {
        this.pociski.splice(i, 1);
        usunObiekt(this.scene, p.obj);
        if (p.onImpact) {
          try {
            p.onImpact();
          } catch (err) {
            console.error('[bossattack] Blad w obsludze uderzenia:', err);
          }
        }
      }
    }

    // 3. Kaluze i dym
    for (let i = this.zanikajace.length - 1; i >= 0; i--) {
      const z = this.zanikajace[i];
      z.zostalo -= delta;
      const post = Math.max(0, z.zostalo / z.calosc);
      if (z.rosnie) {
        const s = 1 + (1 - post) * 2.2;
        z.obj.scale.setScalar(s);
        z.obj.position.y = 0.18 + (1 - post) * 0.5;
      }
      for (const m of z.materialy) m.opacity = Math.max(0, post * 0.8);
      if (z.zostalo <= 0) {
        this.zanikajace.splice(i, 1);
        usunObiekt(this.scene, z.obj);
      }
    }
  }

  clear() {
    for (const z of this.znaczniki) usunObiekt(this.scene, z.obj);
    for (const p of this.pociski) usunObiekt(this.scene, p.obj);
    for (const z of this.zanikajace) usunObiekt(this.scene, z.obj);
    this.znaczniki = [];
    this.pociski = [];
    this.zanikajace = [];
  }
}
