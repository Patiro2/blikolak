import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadArcade } from './assets.js';

const BASE_FOV = 42;
const BASE_POS = new THREE.Vector3(0, 3.2, 5.4);
const LOOK_TARGET = new THREE.Vector3(0, 0.65, 0.1);

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
  // mapSize 4096 (zamiast 2048) polowi rozmiar teksela mapy cieni - mniejszy
  // teksel = mniej widocznego "schodkowania" na plaskiej posadzce przy ruchu
  // kamery pod plaskim katem. Zmierzone (patrz notatka z testu izolowanego
  // niżej): przy bias=0 teksel jest na tyle duzy, ze srednia jasnosc i
  // odchylenie posadzki skacza az 6x (mean 19 -> 65, std 0.1 -> 1.1) - dowod,
  // ze bias/normalBias/mapSize realnie tlumia acne na tej geometrii. Przy
  // obecnym bias=-0.0004 acne na SAMEJ plaskiej plytce podlogi jest juz dobrze
  // stlumione (oscylacja rzedu 0.005-0.01 w izolowanym tescie) - normalBias
  // podniesiony do 0.05 i tesniejszy frustum dodaja margines bezpieczenstwa
  // bez zauwazalnego peter-panningu (sprawdzone wizualnie na stopach postaci).
  dir.shadow.mapSize.set(4096, 4096);
  // Wartosci dobrane pomiarem na prawdziwym plotnie (metryka w diag.js: oscylacja
  // wariancji Laplace'a obrazu posadzki przy powolnym ruchu kamery). Agresywne
  // ustawienia (bias -0.0007, normalBias 0.05) dawaly oscylacje 0.0298, lagodne
  // 0.0236 - a wiekszosc migotania i tak pochodzila nie z cieni, tylko ze
  // wspolplaszczyznowego wierzchu placu miasta (patrz PLAZA_TOP_Y w city.js).
  dir.shadow.bias = -0.0002;
  // normalBias odsuwa punkt probkowania mapy cieni wzdluz normalnej powierzchni.
  // Bez niego duze plaskie powierzchnie (posadzka areny) potrafia rzucac cien
  // same na siebie - shadow acne, widoczne jako migoczace ciemne pasy zmieniajace
  // sie przy ruchu kamery. Sam ujemny bias tego nie rozwiazuje.
  dir.shadow.normalBias = 0.015;
  // radius obnizony z 2.2 - mniejszy promien PCF miekkiego cienia mniej
  // rozmywa/wzmacnia pasma na granicy tekseli mapy cieni.
  dir.shadow.radius = 1.4;
  dir.shadow.camera.near = 0.5;
  dir.shadow.camera.far = 20;
  // Frustum zaciesniony z +-6 do +-5 (arena siega do 3.5, boss/Vanessa
  // potrafia wyjsc poza arene - +-6 zostawia margines, ale wiekszy teksel na
  // szerszym obszarze byl czescia problemu z acne; +-5 to kompromis
  // zweryfikowany wizualnie - cienie bossa/Vanessy przy krawedzi areny nadal
  // sa rzucane poprawnie).
  dir.shadow.camera.left = -5;
  dir.shadow.camera.right = 5;
  dir.shadow.camera.top = 5;
  dir.shadow.camera.bottom = -5;
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

  // Wizualna neonowa siatka 2D na podłodze areny (7x7 pól, każde pole 1.0 x 1.0 m)
  const gridMesh = createFloorGridMesh(SIZE, SIZE);
  group.add(gridMesh);

  scene.add(group);
  return group;
}

/** Tworzy estetyczną, świecącą siatkę 2D na posadzce z wyrysowanymi kwadratami pól. */
function createFloorGridMesh(size, divisions) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, 1024, 1024);

  const cellSize = 1024 / divisions;

  // Każde pole siatki otrzymuje neonową ramkę
  ctx.strokeStyle = 'rgba(83, 252, 24, 0.7)';
  ctx.lineWidth = 4;
  ctx.shadowColor = '#53fc18';
  ctx.shadowBlur = 10;

  for (let x = 0; x < divisions; x++) {
    for (let y = 0; y < divisions; y++) {
      const rx = x * cellSize;
      const ry = y * cellSize;

      ctx.strokeRect(rx + 2, ry + 2, cellSize - 4, cellSize - 4);

      // Subtelny znacznik środka pola
      ctx.fillStyle = 'rgba(83, 252, 24, 0.35)';
      ctx.beginPath();
      ctx.arc(rx + cellSize / 2, ry + cellSize / 2, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  const geo = new THREE.PlaneGeometry(size, size);
  // polygonOffset przesuwa siatke w buforze glebi w strone kamery niezaleznie od
  // jej fizycznej wysokosci - to samo zabezpieczenie, co przy wskazniku pod zlota
  // moneta (patrz goldcoin.js). Bez niego siatka leżała 0.003 j. nad wierzchem
  // kafla podlogi (0.025) - margines zbyt cienki, zeby bezpiecznie przetrwac
  // na kazdej karcie graficznej przy ruchu kamery.
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  // 0.035 zamiast 0.028: wyrazniejszy odstep od wierzchu kafla (0.025), wciaz
  // ponizej wskaznika monety (0.048).
  mesh.position.set(0, 0.035, 0);
  return mesh;
}
