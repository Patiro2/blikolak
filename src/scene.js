import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadArcade } from './assets.js';

const BASE_FOV = 42;
const BASE_POS = new THREE.Vector3(0, 2.7, 4.6);
const LOOK_TARGET = new THREE.Vector3(0, 0.4, 0.35);

/**
 * Przy waskim/wysokim oknie (aspect < 1.3) kadr 42mm/pozycja (0,2.7,4.6) zaweza
 * sie tak bardzo w poziomie, ze pierwszy pracownik zaslania pol ekranu, a
 * maszyna chowa sie za panelem HUD. Cofamy kamere i poszerzamy FOV proporcjonalnie
 * do tego, jak bardzo okno jest waskie.
 */
function applyCameraFraming(camera, aspect) {
  camera.aspect = aspect;
  if (aspect < 1.3) {
    const t = Math.min(1, (1.3 - aspect) / 0.9); // 0 przy 1.3, 1 przy aspect <= 0.4
    camera.fov = BASE_FOV + t * 30;
    camera.position.set(BASE_POS.x, BASE_POS.y + t * 1.6, BASE_POS.z + t * 3.4);
  } else {
    camera.fov = BASE_FOV;
    camera.position.copy(BASE_POS);
  }
  camera.updateProjectionMatrix();
}

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Kinowy Tone Mapping ACESFilmic - żywe, bogate kolory bez przepaleń bieli
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1118);

  // Zwiększenie near z 0.05 do 0.1 podwaja precyzję bufora głębokości (eliminacja Z-fightingu kamery)
  const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 100);
  applyCameraFraming(camera, window.innerWidth / window.innerHeight);
  camera.lookAt(LOOK_TARGET);

  // 1. Ciepłe oświetlenie otoczenia (góra ciepła, spód chłodny granat)
  const hemi = new THREE.HemisphereLight(0xfffaed, 0x181c2b, 0.75);
  scene.add(hemi);

  // 2. Ciepłe światło słoneczne (Key Light) z miękkimi cieniami 2K
  const dir = new THREE.DirectionalLight(0xfffaed, 1.5);
  dir.position.set(3.5, 6, 2.5);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.bias = -0.0004;
  dir.shadow.radius = 2.2;
  dir.shadow.camera.near = 0.5;
  dir.shadow.camera.far = 20;
  dir.shadow.camera.left = -6;
  dir.shadow.camera.right = 6;
  dir.shadow.camera.top = 6;
  dir.shadow.camera.bottom = -6;
  scene.add(dir);

  // 3. Efektowny, złoty reflektor sufitowy (Spotlight) skierowany pionowo w bankomat
  const spot = new THREE.SpotLight(0xffe875, 4.0, 9.0, Math.PI / 4.5, 0.55, 1.2);
  spot.position.set(0, 4.2, 1.2);
  spot.target.position.copy(LOOK_TARGET);
  scene.add(spot);
  scene.add(spot.target);

  // 4. Neonowy blask Kicka przy posadzce (PointLight) oświetlający podstawę automatu i monety
  const neon = new THREE.PointLight(0x53fc18, 1.8, 3.8, 1.4);
  neon.position.set(0, 0.18, 0.45);
  scene.add(neon);

  // 5. Chłodne światło kontrowe (Rim / Backlight) - wydobywa krawędzie postaci i maszyn z tła
  const rim = new THREE.DirectionalLight(0x5478ff, 0.95);
  rim.position.set(-4, 3.5, -3.5);
  scene.add(rim);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.copy(LOOK_TARGET);
  controls.minDistance = 2.2;
  controls.maxDistance = 8.5;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = Math.PI / 2 - 0.04;
  controls.enablePan = false;
  controls.update();

  window.addEventListener('resize', () => {
    const aspect = window.innerWidth / window.innerHeight;
    applyCameraFraming(camera, aspect);
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera, controls, spot, neon };
}

/** Buduje pokój 7x7 ze starannie spasowanymi kafelkami (zero Z-fightingu). */
export async function buildRoom(scene) {
  const SIZE = 7;
  const HALF = Math.floor(SIZE / 2); // 3 (kafle od -3 do +3)

  const [floorGltf, wallGltf, cornerGltf, columnGltf] = await Promise.all([
    loadArcade('floor'), loadArcade('wall'), loadArcade('wall-corner'), loadArcade('column'),
  ]);

  const group = new THREE.Group();

  // Kafelki podłogi (y = 0, ich wierzch ma grubość y = 0.025)
  for (let x = -HALF; x <= HALF; x++) {
    for (let z = -HALF; z <= HALF; z++) {
      const tile = floorGltf.scene.clone(true);
      tile.position.set(x, 0, z);
      group.add(tile);
    }
  }

  // Ściany posadowione są na y = 0.025, dzięki czemu ich spód nie konkuruje
  // płaszczyzną z podłogą (koniec Y-fightingu).
  //
  // Każdy narożnik (wall-corner) zajmuje skrzydła o długości 0.5 jednostki.
  // Pomiędzy narożnikami (-3.0 do +3.0) jest DOKŁADNIE 6.0 jednostek.
  // Umieszczamy dokładnie 6 ścian o szerokości 1.0 (centra: -2.5, -1.5, -0.5, 0.5, 1.5, 2.5),
  // które stykają się idealnie na styk bez ani milimetra nakładania się (zero Z-fightingu).
  const wallY = 0.025;
  const edge = HALF + 0.5; // 3.5
  const wallCenters = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5];

  for (const pos of wallCenters) {
    // Ściana południowa (+Z, tył kamery)
    const wallS = wallGltf.scene.clone(true);
    wallS.position.set(pos, wallY, edge);
    wallS.rotation.y = Math.PI;
    group.add(wallS);

    // Ściana północna (-Z)
    const wallN = wallGltf.scene.clone(true);
    wallN.position.set(pos, wallY, -edge);
    group.add(wallN);

    // Ściana wschodnia (+X)
    const wallE = wallGltf.scene.clone(true);
    wallE.position.set(edge, wallY, pos);
    wallE.rotation.y = -Math.PI / 2;
    group.add(wallE);

    // Ściana zachodnia (-X)
    const wallW = wallGltf.scene.clone(true);
    wallW.position.set(-edge, wallY, pos);
    wallW.rotation.y = Math.PI / 2;
    group.add(wallW);
  }

  // 4 Narożniki w rogach (3.5, 3.5) na poziomie y = 0.025
  const cornerPositions = [
    { x: edge, z: edge, ry: Math.PI },
    { x: -edge, z: edge, ry: Math.PI / 2 },
    { x: edge, z: -edge, ry: -Math.PI / 2 },
    { x: -edge, z: -edge, ry: 0 },
  ];
  for (const c of cornerPositions) {
    const corner = cornerGltf.scene.clone(true);
    corner.position.set(c.x, wallY, c.z);
    corner.rotation.y = c.ry;
    group.add(corner);
  }

  // Ozdobne kolumny narożne wewnątrz pokoju
  const columnPositions = [
    { x: HALF - 0.5, z: HALF - 0.5 },
    { x: -(HALF - 0.5), z: HALF - 0.5 },
    { x: HALF - 0.5, z: -(HALF - 0.5) },
    { x: -(HALF - 0.5), z: -(HALF - 0.5) },
  ];
  for (const c of columnPositions) {
    const col = columnGltf.scene.clone(true);
    col.position.set(c.x, wallY, c.z);
    group.add(col);
  }

  scene.add(group);
  return group;
}
