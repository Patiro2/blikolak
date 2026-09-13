import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadArcade, loadForest } from './assets.js';

const BASE_FOV = 42;
const BASE_POS = new THREE.Vector3(0, 3.2, 5.4);
const LOOK_TARGET = new THREE.Vector3(0, 0.65, 0.1);

// Warstwa (THREE.Layers) dla obiektow, ktore MAJA dostac selektywny bloom
// (patrz UnrealBloomPass w main.js). Uzywana tu (siatka neonowa podlogi) i w
// city.js (latarnie/neonowe akcenty/swiatla aut) - NIGDY na kartach/etykietach
// minigier (boss-blackjack.js, tlumaczenia.js), zeby czytelnosc HUD 3D byla
// gwarantowana samą konstrukcją, a nie tylko dobranym progiem bloomu.
export const BLOOM_LAYER = 1;

/**
 * Buduje minimalna "kapsule" do wypalenia mapy srodowiska (PMREM) zamiast
 * jasnego RoomEnvironment z three/addons. Zmierzone przy poprzednim podejsciu
 * (RoomEnvironment, patrz historia tego pliku): render z domyslnej kamery przy
 * scene.environment = null i przy scene.environment = RoomEnvironment byl
 * PRAKTYCZNIE IDENTYCZNY - RoomEnvironment to jasne studio z kilkoma
 * kolorowymi "softboxami", zaprojektowane pod dzienne/warsztatowe sceny, wiec
 * przy naszym mocno przygaszonym, nocnym rigu jego IBL ginal w tle i nie byl
 * w stanie wplynac na nastroj. Wlasna, ciemna, dwutonowa "kapsula" (chlodny
 * granat u gory jak nocne niebo, niemal-czarny cieply dol) daje materialom
 * Kenney widoczne, ale STONOWANE odbicia otoczenia bez podbijania ogolnej
 * jasnosci sceny - kontrolujemy intensywnosc samą zawartoscią sceny zrodlowej
 * (three@0.160 w tym projekcie NIE ma jeszcze scene.environmentIntensity -
 * dodane dopiero w r163+, sprawdzone w konsoli przegladarki), nie mnoznikiem.
 */
function buildNightEnvironmentScene() {
  const envScene = new THREE.Scene();

  const geo = new THREE.SphereGeometry(6, 16, 16);
  const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true });
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const colorTop = new THREE.Color(0x1c2748); // chlodny granat "nieba"
  const colorBottom = new THREE.Color(0x0a0705); // niemal czarny, lekko cieply
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp((pos.getY(i) / 6 + 1) / 2, 0, 1);
    tmp.copy(colorBottom).lerp(colorTop, t);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  envScene.add(new THREE.Mesh(geo, mat));

  // Przygaszony cieply "punkt" (odpowiednik zlotego spotu/neonu Kicka) - bez
  // niego gladkie/metaliczne powierzchnie dostawalyby WYLACZNIE chlodne
  // odbicia nieba ze wszystkich stron, co wygladaloby monotonnie. Mala kula,
  // stonowany kolor (nie czysta biel) - to tylko drugi ton odbicia, nie ma
  // sluzyc jako realne zrodlo swiatla sceny.
  const warm = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xa96a3a }),
  );
  warm.position.set(2.4, 1.0, 1.6);
  envScene.add(warm);

  return envScene;
}

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
  // Kinowy Tone Mapping ACESFilmic - żywe, bogate kolory bez przepaleń bieli.
  // Ekspozycja obnizona z 1.15 do 0.92 - caly rig ponizej jest teraz WYRAZNIE
  // ciemniejszy (nastroj nocy, patrz swiatlo 1-2), wiec ACES dostaje material
  // wejsciowy, ktory juz sam w sobie nie jest jasnym "dniem" - nizsza
  // ekspozycja poglebia kontrast cien/akcent zamiast podnosic ogolna jasnosc
  // z powrotem do poprzedniego, dziennego wygladu.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1118);

  // Environment map (IBL) - generowana RAZ, przy starcie (PMREMGenerator,
  // jednorazowy koszt rzedu ~20ms, zmierzone; zero kosztu per-klatke pozniej).
  // Modele Kenney (MeshStandardMaterial z GLB) bez tego maja wylacznie
  // oswietlenie kierunkowe/punktowe - plaskie, matowe powierzchnie bez
  // zadnego odbicia otoczenia. Zrodlo PMREM to WLASNA, ciemna "kapsula"
  // (buildNightEnvironmentScene powyzej), NIE domyslny RoomEnvironment z
  // three/addons - RoomEnvironment jest jasnym studiem i przy naszym nocnym
  // rigu jego wplyw byl NIEZAUWAZALNY (zmierzone: zrzut z env=null i
  // env=RoomEnvironment byl praktycznie identyczny z domyslnej kamery).
  // scene.environment (NIE scene.background) - tlo/mgla/miasto (city.js)
  // zostaja bez zmian.
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = pmremGenerator.fromScene(buildNightEnvironmentScene(), 0.04).texture;
  pmremGenerator.dispose();

  // Zwiększenie near z 0.05 do 0.1 podwaja precyzję bufora głębokości (eliminacja Z-fightingu kamery)
  const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 100);
  applyCameraFraming(camera, window.innerWidth / window.innerHeight);
  camera.lookAt(LOOK_TARGET);

  // 1. Otoczenie nocnego miasta (Hemisphere) - chlodny granat nieba u gory,
  // niemal-czarny cieply odblask ulicy/neonow u dolu. Intensywnosc zbita z
  // 0.75 do 0.22 - to byla GLOWNA przyczyna "plaskiego, jasnego dnia" z
  // poprzedniej wersji: przy 0.75 i cieplym gornym kolorze hemi samo w sobie
  // wypelnialo caly cien rownomiernym, jasnym swiatlem, zabijajac kontrast
  // miedzy arena (ma byc punktem skupienia) a jej krawedziami.
  const hemi = new THREE.HemisphereLight(0x2c3c63, 0x0d0a08, 0.22);
  scene.add(hemi);

  // 2. Chlodne swiatlo ksiezycowe (Key Light) z miekkimi cieniami 2K - kolor
  // zmieniony z cieplego 0xfffaed (dzien) na chlodny niebieskawy 0x9fc2ff
  // (poswiata ksiezyca), intensywnosc zbita z 1.5 do 0.85. To DRUGA glowna
  // przyczyna dziennego wygladu: cieply, mocny kierunkowy key swiecil jak
  // slonce. Cienie (mapSize/bias/normalBias/radius/frustum) NIE ruszane -
  // to jest oddzielnie zmierzony, udokumentowany tuning (patrz komentarze
  // nizej), zmiana koloru/intensywnosci swiatla go nie uniewaznia.
  const dir = new THREE.DirectionalLight(0x9fc2ff, 0.85);
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

  // 3. Efektowny, złoty reflektor sufitowy (Spotlight) skierowany pionowo w
  // bankomat - intensywnosc PODNIESIONA z 4.0 do 6.5 (kat lekko zwezony), zeby
  // w duzo ciemniejszej scenie nadal wyraznie "wybijal" bankomat jako punkt
  // skupienia - to jest kontrast wzgledem reszty rigu (2 i 3 razy jasniejszy
  // od key light), nie absolutna jasnosc.
  const spot = new THREE.SpotLight(0xffd27a, 6.5, 9.0, Math.PI / 5, 0.5, 1.25);
  spot.position.set(0, 4.2, 1.2);
  spot.target.position.copy(LOOK_TARGET);
  scene.add(spot);
  scene.add(spot.target);

  // 4. Neonowy blask Kicka przy posadzce (PointLight) oświetlający podstawę
  // automatu i monety - podniesiony z 1.8 do 2.6, zeby przy niskim hemi/key
  // nadal wyraznie swiecil na plytkach wokol automatu (widoczny akcent
  // ciepla/zimna: zielony neon vs chlodny key/rim).
  const neon = new THREE.PointLight(0x53fc18, 2.6, 4.2, 1.4);
  neon.position.set(0, 0.18, 0.45);
  scene.add(neon);

  // 5. Chłodne światło kontrowe (Rim / Backlight) - wydobywa krawędzie
  // postaci i maszyn z ciemnego tla. Lekko podniesione (0.95 -> 1.1), bo przy
  // niskim hemi sylwetki bez rima ginelyby w cieniu bardziej niz wczesniej.
  const rim = new THREE.DirectionalLight(0x4a6bff, 1.1);
  rim.position.set(-4, 3.5, -3.5);
  scene.add(rim);

  // 6. Cieple, szerokie swiatlo wypelniajace arene (PointLight BEZ cieni -
  // castShadow domyslnie false, wiec zero dodatkowego kosztu shadow-mapy) -
  // rig 1-5 jest teraz swiadomie ciemny/kontrastowy (nastroj nocy + arena
  // jako punkt skupienia), ale to zostawialoby postacie na KRAWEDZIACH areny
  // (np. w rogu, daleko od zlotego spotu i neonu) w prawie calkowitym cieniu -
  // ich plakietki z nickiem (DOM, rzutowane z pozycji 3D, patrz
  // workerOverlays.updatePositions w main.js) zostalyby czytelne, ale sama
  // postac na canvasie nie. To swiatlo stoi wysoko nad SRODKIEM areny i ma
  // spory zasieg (7.5 j. - obejmuje cala plyte 7x7 do naroznikow) i niska
  // intensywnosc, wiec podnosi tylko dolna granice jasnosci (fill), nie
  // konkuruje z zadnym z gorna akcentow.
  const fill = new THREE.PointLight(0xffb87a, 0.9, 7.5, 1.6);
  fill.position.set(0, 2.7, 0.1);
  scene.add(fill);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.copy(LOOK_TARGET);
  controls.minDistance = 2.2;
  // Podniesione z 8.5 do 17 (2x) - wlasciciel chcial wyraznie wieksze oddalenie.
  // Geometria tla w city.js (FOREGROUND_TALL_*, BUILDING_KEEPOUT_RADIUS,
  // CITY_HALF, FOG_NEAR/FAR) jest przeliczona pod ta wartosc - patrz komentarze
  // tam, punkt wyjscia to teoretyczny najdalszy promien kamery od (0,0,0):
  // maxDistance + |LOOK_TARGET| = 17 + 0.658 = ~17.66.
  controls.maxDistance = 17;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = Math.PI / 2 - 0.04;
  controls.enablePan = false;
  controls.update();

  window.addEventListener('resize', () => {
    const aspect = window.innerWidth / window.innerHeight;
    applyCameraFraming(camera, aspect);
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera, controls, spot, neon, fill };
}

/** Zwraca pierwszy THREE.Mesh znaleziony w scenie GLTF (fence.glb ma dokladnie jeden). */
function firstMesh(gltf) {
  let found = null;
  gltf.scene.traverse((o) => {
    if (!found && o.isMesh) found = o;
  });
  return found;
}

/** Buduje pokój 7x7 ze starannie spasowanymi kafelkami (zero Z-fightingu). */
export async function buildRoom(scene) {
  const SIZE = 7;
  const HALF = Math.floor(SIZE / 2); // 3 (kafle od -3 do +3)

  const [floorGltf, fenceGltf] = await Promise.all([
    loadArcade('floor'), loadForest('fence'),
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

  // Granica areny: plotek kenney_mini-forest (assets/forest/fence.glb) zamiast
  // dawnych scian/naroznikow z mini-arcade (wall.glb/wall-corner.glb).
  //
  // Zmierzony bbox fence.glb (skrypt z CLAUDE.md): x[-0.548,0.548] (dlugosc
  // wzdluz lokalnej osi X), y[0,0.4] (wysokosc), z[-0.1229,0.1229] (grubosc
  // panelu, 0.2458 lacznie). Segment jest szerszy (1.096) niz siatka areny
  // (1.0), wiec 7 segmentow na bok (centra -3..3, jak kafle podlogi) zachodzi
  // na siebie po ok. 0.048 z kazdej strony styku i laczy sie bez szczelin.
  //
  // Granica NIE stoi dokladnie na krawedzi siatki (3.5) tylko w odsunieciu
  // FENCE_OFFSET na zewnatrz. Powod: minigry flagbattle.js/tlumaczenia.js (nie
  // ruszane w tym zadaniu) stawiaja WLASNE plotki z tego samego modelu wokol
  // kontestowanego pola na pozycjach tile+-0.5 - dla pola przy krawedzi areny
  // (np. x=3,z=0) ich plotek wypada dokladnie na x=3.5 z tym samym rot=PI/2,
  // czyli ta sama orientacja i os co nasz rzad wschodni.
  // Zmierzone (przeliczenie transformacji rot.y=PI/2, ta sama metoda co dla
  // minigry): przy sugerowanym w planie odsunieciu 0.12-0.15 (fenceEdge~3.62-
  // 3.65) plotek granicy i plotek minigry NADAL SIE PRZENIKAJA - wewnetrzna
  // (blizsza arenie) sciana naszego plotka wypada na fenceEdge-0.1229, a
  // zewnetrzna sciana plotka minigry na 3.5+0.1229=3.623; przy fenceEdge=3.63
  // to 3.507 < 3.623, czyli zakladanie siatek na ~0.12 j. Dopiero odsuniecie
  // >= ~0.2458+0.03 marginesu (czyli fenceEdge >= 3.78) daje realny przeswit.
  // Uzyte FENCE_OFFSET=0.3 (fenceEdge=3.8) daje ok. 5.4 cm czystego odstepu -
  // zweryfikowane w raporcie zadania (zblizenie + zmierzone wspolrzedne).
  // To ODSTEPSTWO od zaproponowanej w planie wartosci 0.12-0.15 - potrzebne,
  // bo plotek ma realna grubosc (0.2458 j.), nie jest plaskim dekalem.
  const FENCE_OFFSET = 0.3;
  const FENCE_EDGE = HALF + 0.5; // 3.5 - krawedz siatki areny/plotkow minigry
  const fenceEdge = FENCE_EDGE + FENCE_OFFSET; // 3.8
  // Granica lezy poza kaflami podlogi (te siegaja tylko do 3.5), a wiec nad
  // plazą z city.js (CityBackground._buildPlaza). Plac ma tam DWIE
  // powierzchnie: betonowy cokol (PLAZA_TOP_Y=-0.02) i cienka nakladke z
  // trawa/sciezkami tuz nad nim (plazaTopY+0.005 = -0.015, patrz
  // createPlazaGroundTexture w city.js). Podpieramy plotek 0.007 j. NAD TA
  // NAKLADKA (nie dokladnie na niej), zeby nie byc wspolplaszczyznowym z jej
  // gorna powierzchnia, a jednoczesnie nie "wisiec" w powietrzu (odstep
  // niezauwazalny wizualnie).
  const FENCE_Y = -0.008;
  const fenceCenters = [-3, -2, -1, 0, 1, 2, 3];

  // Cala granica (28 segmentow + 4 rogi = 32 instancje) to JEDEN InstancedMesh
  // zamiast 32 osobnych klonow gltf.scene - kazdy klon byl wlasnym draw call,
  // co mierzalnie podbijalo renderer.info.render.calls (zmierzone w raporcie
  // zadania: ~28 dodatkowych wywolan tylko na sam plotek). Ta sama geometria
  // i material (fence.glb ma dokladnie jeden mesh) wiec instancing jest
  // bezpieczny - zero roznicy wizualnej, jeden draw call zamiast 32.
  const fenceMesh = firstMesh(fenceGltf);
  const FENCE_INSTANCE_COUNT = fenceCenters.length * 4 + 4;
  const fenceInst = new THREE.InstancedMesh(fenceMesh.geometry, fenceMesh.material, FENCE_INSTANCE_COUNT);
  fenceInst.castShadow = true;
  fenceInst.receiveShadow = true;
  fenceInst.frustumCulled = false;

  const fenceDummy = new THREE.Object3D();
  let fenceIdx = 0;
  const placeFence = (x, z, ry, scaleX = 1) => {
    fenceDummy.position.set(x, FENCE_Y, z);
    fenceDummy.rotation.set(0, ry, 0);
    fenceDummy.scale.set(scaleX, 1, 1);
    fenceDummy.updateMatrix();
    fenceInst.setMatrixAt(fenceIdx++, fenceDummy.matrix);
  };

  // Rotacje zgodne z konwencja flagbattle.js/tlumaczenia.js (boki wokol pola:
  // dz=+0.5 -> rot=0, dz=-0.5 -> rot=PI, dx=+0.5 -> rot=PI/2, dx=-0.5 ->
  // rot=-PI/2), zeby orientacja tekstury plotka byla spojna w calej grze.
  for (const c of fenceCenters) {
    placeFence(c, fenceEdge, 0); // +Z
    placeFence(c, -fenceEdge, Math.PI); // -Z
    placeFence(fenceEdge, c, Math.PI / 2); // +X
    placeFence(-fenceEdge, c, -Math.PI / 2); // -X
  }

  // Rogi: ostatnie slupki rzedow (koniec segmentu na +-3.548) nie stykaja sie
  // w rogu (+-3.8,+-3.8) - dzieli je ok. 0.36 j. po przekatnej. Domykamy to
  // krotkim segmentem tego samego fence.glb, polozonym STYCZNIE do rogu (po
  // przekatnej miedzy tymi dwoma slupkami) i scisnietym wzdluz lokalnej osi X.
  // Segment ustawiony wzdluz dwusiecznej (atan2(-sz, sx), bez +PI/2) sterczal
  // z rogu na zewnatrz jak ostroga - sprawdzone zrzutem z bliska.
  const FENCE_LEN = 1.096; // zmierzona dlugosc fence.glb wzdluz lokalnej osi X
  const fenceRowEnd = fenceCenters[fenceCenters.length - 1] + FENCE_LEN / 2; // 3.548
  const cornerMid = (fenceEdge + fenceRowEnd) / 2;
  const cornerScaleX = (Math.SQRT2 * (fenceEdge - fenceRowEnd)) / FENCE_LEN + 0.15;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      placeFence(sx * cornerMid, sz * cornerMid, Math.atan2(-sz, sx) + Math.PI / 2, cornerScaleX);
    }
  }

  fenceInst.instanceMatrix.needsUpdate = true;
  group.add(fenceInst);

  // Wizualna neonowa siatka 2D na podłodze areny (7x7 pól, każde pole 1.0 x 1.0 m)
  const gridMesh = createFloorGridMesh(SIZE, SIZE);
  // UWAGA: SWIADOMIE nie na warstwie bloomu. Zmierzone/sprawdzone wizualnie -
  // to duza plaszczyzna pokrywajaca praktycznie cala widoczna arene, wiec
  // nawet subtelny UnrealBloomPass rozmywa sie na niej w jeden, ekranowy
  // zielony poblask, ktory bije po oczach i (co gorsza) zabiera kontrast
  // dokladnie tym elementom, ktorych bloom mial NIE dotykac (karty, etykiety
  // DOBIERZ/PASUJ stojace na tej samej podlodze - patrz test w raporcie
  // zadania z boss 3). Bloom w tym projekcie jest wiec zarezerwowany dla
  // MALYCH, punktowych zrodel (latarnie/neonowe szyldy/krawedz placu/swiatla
  // aut w city.js) - siatka zostaje czytelnym neonem tylko dzieki wlasnej
  // teksturze/kolorowi, bez postprocessingu.
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
