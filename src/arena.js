// Rozmiar areny - rosnie z 7x7 (pola -3..3) do 9x9 (pola -4..4) po pokonaniu
// bossa Skorpiona (tier 4, patrz BOSS_DEFS[4] w boss.js). Jedno zrodlo prawdy
// dla WSZYSTKICH konsumentow (scene.js, city.js, workers.js, minigry,
// bossowie, goldcoin.js, jetpack.js) - kazdy z nich woła arenaHalf()
// W MOMENCIE UZYCIA (nie trzyma wlasnej stalej), wiec zmiana propaguje sie
// wszedzie bez dodatkowego stanu w zapisie gry.
//
// Ten sam modul odpowiada tez za JEDNORAZOWA cutscenke powiekszenia (patrz
// growWithCutscene nizej) - wolana z main.js: u hosta z onDefeated po
// dopisaniu tieru 4 do bossesDefeated, u widza w kroku 'economy' w
// zastosujStanZSerwera przy wykryciu przejscia "nie mial Skorpiona -> ma".
//
// Zrodlo prawdy o postepie: economy.state.bossesDefeated (tablica tierow).

import * as THREE from 'three';
import { buildRoom, setCameraArenaHalf } from './scene.js';
import { audio } from './audio.js';

export const SKORPION_TIER = 4;

/** Polowa boku areny: 3 (7x7) domyslnie, 4 (9x9) po pokonaniu Skorpiona. */
export function arenaHalf(economy) {
  return economy.state.bossesDefeated.includes(SKORPION_TIER) ? 4 : 3;
}

/** Bok areny w polach (7 albo 9). */
export function arenaSize(economy) {
  return arenaHalf(economy) * 2 + 1;
}

/** Czy wspolrzedne (x,z) - zaokraglone do pola - leza na aktualnej arenie. */
export function wSiatce(economy, x, z) {
  const half = arenaHalf(economy);
  return Math.abs(x) <= half && Math.abs(z) <= half;
}

/** Przycina wspolrzedna do zakresu aktualnej areny. */
export function przytnijDoAreny(economy, v) {
  const half = arenaHalf(economy);
  return Math.max(-half, Math.min(half, v));
}

// ============================ CUTSCENKA POWIEKSZENIA ============================

let ctx = null; // {scene, camera, controls} - ustawiane raz przez init()
let domReady = false;
let letterboxTop, letterboxBottom, titleCardEl, titleNameEl, titleSubEl;

let cameraLocked = false;
let cutsceneActive = false;
let cutsceneT = 0;
let cutsceneDuration = 7;
let savedCamPos = new THREE.Vector3();
let savedCamTarget = new THREE.Vector3();
let kinoPos = new THREE.Vector3();
let kinoTarget = new THREE.Vector3();
let group = null; // grupa areny zbudowana przez buildRoom(..., {riseFromHalf})
let wavePortion = 0.6; // udzial czasu cutscenki na fale kafli (reszta = pop plotka + wytrzymanie kamery)
let RISE_DUR = 0.5; // s - czas wznoszenia sie JEDNEGO kafla
let fencePopped = false;
let shockwave = null; // pojedynczy Mesh "fali" efektu, sprzatany na koncu

function smoothstep(t) {
  const k = Math.max(0, Math.min(1, t));
  return k * k * (3 - 2 * k);
}

function ensureDom() {
  if (domReady) return;
  domReady = true;

  letterboxTop = document.createElement('div');
  letterboxTop.className = 'boss-letterbox boss-letterbox-top';
  letterboxBottom = document.createElement('div');
  letterboxBottom.className = 'boss-letterbox boss-letterbox-bottom';
  document.body.appendChild(letterboxTop);
  document.body.appendChild(letterboxBottom);

  titleCardEl = document.createElement('div');
  titleCardEl.className = 'boss-title-card';
  titleNameEl = document.createElement('div');
  titleNameEl.className = 'boss-title-name';
  titleSubEl = document.createElement('div');
  titleSubEl.className = 'boss-title-sub';
  titleCardEl.appendChild(titleNameEl);
  titleCardEl.appendChild(titleSubEl);
  document.body.appendChild(titleCardEl);
}

/** Wolane raz z main.js po zbudowaniu sceny/kamery/kontrolek/economy. */
export function init({ scene, camera, controls, economy }) {
  ctx = { scene, camera, controls, economy };
  ensureDom();
}

/** main.js pomija wtedy controls.update() - ten sam wzorzec co boss.isCameraLocked(). */
export function isCameraLocked() {
  return cameraLocked;
}

function buildShockwave(scene, radius) {
  const geo = new THREE.RingGeometry(0.05, 0.35, 32);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.06;
  mesh.userData.targetRadius = radius;
  scene.add(mesh);
  return mesh;
}

/**
 * Odpala JEDNORAZOWA animowana cutscenke powiekszenia areny do aktualnego
 * arenaHalf(economy) (wolajacy musi juz miec economy.state.bossesDefeated
 * zaktualizowane - ta funkcja tylko animuje przejscie do tego, co
 * arenaHalf() juz zwraca). Jesli arena jest juz w docelowym rozmiarze (np.
 * podwojne wywolanie), po cichu tylko dogrywa buildRoom() bez animacji.
 */
export async function growWithCutscene(economy, options = {}) {
  if (!ctx) throw new Error('arena.init() nie zostalo wywolane');
  const { scene, camera, controls } = ctx;
  const duration = options.duration || cutsceneDuration;

  const oldGroup = scene.userData.arenaRoom;
  const oldHalf = oldGroup ? oldGroup.userData.half : 3;
  const newHalf = arenaHalf(economy);
  if (newHalf === oldHalf) {
    await buildRoom(scene, economy);
    setCameraArenaHalf(camera, controls, newHalf);
    return;
  }

  cutsceneDuration = duration;
  cutsceneT = 0;
  fencePopped = false;

  savedCamPos.copy(camera.position);
  savedCamTarget.copy(controls.target);
  // Kamera kinowa: uniesiona i odsunieta wzgledem biezacej pozycji - dziala
  // poprawnie niezaleznie od tego, czy gracz akurat trzyma desktopowe czy
  // mobilne kadrowanie (patrz applyCameraFraming w scene.js).
  kinoPos.set(camera.position.x * 0.6, camera.position.y * 2.1 + 3.2, camera.position.z * 1.6 + 2.2);
  kinoTarget.set(0, 0.4, 0);

  cameraLocked = true;
  controls.enabled = false;

  void letterboxTop.offsetWidth; // reflow - zeby animacje CSS zawsze wystartowaly od nowa
  letterboxTop.classList.add('show');
  letterboxBottom.classList.add('show');
  titleNameEl.textContent = '🏟️ ARENA SIĘ POWIĘKSZA';
  titleSubEl.textContent = `${newHalf * 2 + 1} × ${newHalf * 2 + 1}`;
  titleCardEl.classList.remove('show');
  void titleCardEl.offsetWidth;
  titleCardEl.classList.add('show');

  audio.play('boss-wejscie'); // niski pomruk - ten sam dzwiek co wejscie bossa, pasuje do "cos duzego sie dzieje"

  // Buduje OD RAZU kanoniczna grupe docelowego rozmiaru (dokladnie ta sama
  // sciezka co instant buildRoom() przy starcie/resecie) - jedyna roznica to
  // opts.riseFromHalf, ktore chowa nowy pierscien kafli pod podloga i zwija
  // plotek do skali ~0, zeby ta funkcja mogla je odslonic fala. Kafle w
  // promieniu oldHalf sa piksel-identyczne w starym i nowym rozmiarze (ta sama
  // szachownica: parzystosc (x+HALF+z+HALF)%2 nie zalezy od HALF, bo HALF
  // rosnie o 1 w obu wspolrzednych na raz - dowod w komentarzu przy buildRoom
  // w scene.js), wiec zniknieicie starej grupy i pojawienie sie nowej w tej
  // samej klatce jest wizualnie bezszwowe.
  group = await buildRoom(scene, economy, { riseFromHalf: oldHalf });
  if (group.userData.gridMesh) group.userData.gridMesh.visible = false;

  shockwave = buildShockwave(scene, (newHalf + 0.8));

  await new Promise((resolve) => {
    _resolveCutscene = resolve;
    cutsceneActive = true;
  });
}

let _resolveCutscene = null;

/** Wolane co klatke z main.js (animate()) - no-op, gdy cutscenka nie trwa. */
export function update(delta) {
  if (!cutsceneActive) return;
  cutsceneT += delta;
  const u = Math.min(1, cutsceneT / cutsceneDuration);
  const { camera, controls } = ctx;

  // Kamera: wjazd w pierwszych 15%, trzymanie, zjazd z powrotem w ostatnich 22% - ten sam wzorzec co boss.js.
  if (u < 0.15) {
    const k = smoothstep(u / 0.15);
    camera.position.lerpVectors(savedCamPos, kinoPos, k);
    controls.target.lerpVectors(savedCamTarget, kinoTarget, k);
  } else if (u >= 0.78) {
    const k = smoothstep((u - 0.78) / 0.22);
    camera.position.lerpVectors(kinoPos, savedCamPos, k);
    controls.target.lerpVectors(kinoTarget, savedCamTarget, k);
  } else {
    camera.position.copy(kinoPos);
    controls.target.copy(kinoTarget);
  }
  camera.lookAt(controls.target);

  // Fala kafli od srodka na zewnatrz: kazdy kafel POZA starym promieniem ma
  // wlasne opoznienie proporcjonalne do odleglosci "krolem" od srodka.
  const queue = group.userData.growthQueue || [];
  if (queue.length > 0) {
    const oldHalf = group.userData.riseFromHalf; // np. 3 - kafle od oldHalf+1 do newHalf sa w tej kolejce
    const newHalf = group.userData.half;
    // Dystans EUKLIDESOWY od srodka (nie "krolem") - nowy pierscien to zawsze
    // JEDEN pas kafli (oldHalf+1..newHalf), wiec staggerowanie po odleglosci
    // "krolem" dawaloby jednoczesny start calego pierscienia. Odleglosc
    // euklidesowa rozklada start plynnie: srodki bokow (np. (4,0), dist=4)
    // wznosza sie pierwsze, rogi (np. (4,4), dist=5.66) na koncu - realna
    // "fala od srodka na zewnatrz" nawet przy pierscieniu grubosci 1.
    const minDist = oldHalf + 1;
    const maxDist = Math.SQRT2 * newHalf;
    const span = Math.max(0.001, maxDist - minDist);
    const waveWindow = cutsceneDuration * wavePortion;
    const dummy = new THREE.Object3D();
    for (const entry of queue) {
      const dist = Math.hypot(entry.x, entry.z);
      const startFrac = Math.max(0, Math.min(1, (dist - minDist) / span)) * 0.85;
      const startT = startFrac * waveWindow;
      const localT = Math.max(0, Math.min(1, (cutsceneT - startT) / RISE_DUR));
      if (localT <= 0) continue;
      const eased = smoothstep(localT);
      const y = THREE.MathUtils.lerp(-1.3, 0, eased);
      entry.inst.getMatrixAt(entry.index, dummy.matrix);
      dummy.position.set(entry.x, y, entry.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      entry.inst.setMatrixAt(entry.index, dummy.matrix);
      entry.inst.instanceMatrix.needsUpdate = true;
    }
  }

  // Plotek "wyskakuje" na nowy obwod, gdy fala kafli dobiega konca.
  const waveEnd = wavePortion;
  if (u >= waveEnd) {
    const popT = Math.min(1, (u - waveEnd) / 0.12);
    const s = smoothstep(popT);
    if (group.userData.fenceInst) group.userData.fenceInst.scale.setScalar(Math.max(0.0001, s));
    if (group.userData.gridMesh) group.userData.gridMesh.visible = true;
    if (!fencePopped && s > 0.05) {
      fencePopped = true;
      audio.play('moneta-spawn'); // krotki "pop" - najblizszy istniejacy dzwiek temu, co tu sie dzieje
    }
  }

  // Obloczek pylu - pojedynczy pierscien rozszerzajacy sie i gasnacy przez cala cutscenke.
  if (shockwave) {
    const k = smoothstep(u);
    const r = THREE.MathUtils.lerp(0.3, shockwave.userData.targetRadius, k);
    shockwave.scale.setScalar(r / 0.2);
    shockwave.material.opacity = 0.8 * (1 - k);
  }

  if (u >= 1) {
    _finishCutscene();
  }
}

function _finishCutscene() {
  const { scene, camera, controls } = ctx;

  // Domykamy kazdy kafel dokladnie na y=0 i plotek/siatke na finalnej skali/widocznosci -
  // interpolacja wyzej mogla zostawic drobny blad zaokraglenia.
  const queue = group.userData.growthQueue || [];
  const dummy = new THREE.Object3D();
  for (const entry of queue) {
    dummy.position.set(entry.x, 0, entry.z);
    dummy.updateMatrix();
    entry.inst.setMatrixAt(entry.index, dummy.matrix);
    entry.inst.instanceMatrix.needsUpdate = true;
  }
  if (group.userData.fenceInst) group.userData.fenceInst.scale.setScalar(1);
  if (group.userData.gridMesh) group.userData.gridMesh.visible = true;

  if (shockwave) {
    scene.remove(shockwave);
    shockwave.geometry.dispose();
    shockwave.material.dispose();
    shockwave = null;
  }

  letterboxTop.classList.remove('show');
  letterboxBottom.classList.remove('show');
  titleCardEl.classList.remove('show');

  // NIE savedCamPos (to byla kamera dostrojona pod STARY rozmiar areny) -
  // setCameraArenaHalf przelicza kadrowanie pod NOWY rozmiar (patrz
  // ARENA_SCALE_PER_HALF w scene.js), zeby cala powiekszona arena miescila
  // sie w kadrze od razu po cutscence, bez skoku przy nastepnym resize.
  setCameraArenaHalf(camera, controls, group.userData.half);
  controls.target.copy(savedCamTarget);
  camera.lookAt(controls.target);
  controls.enabled = true;
  cameraLocked = false;
  cutsceneActive = false;

  const resolve = _resolveCutscene;
  _resolveCutscene = null;
  group = null;
  if (resolve) resolve();
}

// ============================ HAK TESTOWY (window.__game.arena) ============================

/**
 * WYLACZNIE do debugowania z konsoli - patrz raport zadania. `cutscena: true`
 * (domyslnie) odgrywa pelna animacje, `cutscena: false` przeskakuje od razu
 * do docelowego rozmiaru (przydatne przy szybkich testach rozkladu spawnow).
 * Jesli tier 4 nie jest jeszcze w bossesDefeated, ta funkcja go dopisuje
 * (TYLKO do testow - normalna gra robi to w main.js po zwycienstwie nad
 * Skorpionem). Uzywa economy z init() - wywolywalne z konsoli jako
 * window.__game.arena.powieksz({ cutscena: true }).
 */
export async function powieksz({ cutscena = true } = {}) {
  if (!ctx) throw new Error('arena.init() nie zostalo wywolane');
  const { economy } = ctx;
  if (!economy.state.bossesDefeated.includes(SKORPION_TIER)) {
    economy.state.bossesDefeated.push(SKORPION_TIER);
  }
  if (cutscena) {
    await growWithCutscene(economy);
  } else {
    await buildRoom(ctx.scene, economy);
    setCameraArenaHalf(ctx.camera, ctx.controls, arenaHalf(economy));
  }
}

/** WYLACZNIE do debugowania - cofa arene do 7x7 bez animacji (usuwa tier 4 z bossesDefeated). */
export async function zmniejsz() {
  if (!ctx) throw new Error('arena.init() nie zostalo wywolane');
  const { economy } = ctx;
  economy.state.bossesDefeated = economy.state.bossesDefeated.filter((t) => t !== SKORPION_TIER);
  await buildRoom(ctx.scene, economy);
  setCameraArenaHalf(ctx.camera, ctx.controls, arenaHalf(economy));
}
