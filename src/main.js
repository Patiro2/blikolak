import * as THREE from 'three';
import { createScene, buildRoom } from './scene.js';
import { preloadAll } from './assets.js';
import { Machine } from './machine.js';
import { WorkerManager } from './workers.js';
import { CoinPool } from './coins.js';
import { GoldenCoinManager } from './goldcoin.js';
import { Economy, WORKER_TYPE_DEFS, MACHINE_TIERS } from './economy.js';
import { UI, KickUI, LeaderboardUI, WorkerOverlayManager, VanessaLogUI } from './ui.js';
import { KickChatClient } from './kick.js';
import { VanessaManager, showTopAnnouncement } from './vanessa.js';
import { BossManager, BOSS_DEFS } from './boss.js';
import { fmtShort } from './format.js';

async function main() {
  const canvas = document.getElementById('scene');
  const { renderer, scene, camera, controls } = createScene(canvas);

  const economy = new Economy();

  await preloadAll();
  await buildRoom(scene);

  const machine = new Machine(scene, camera, renderer.domElement);
  await machine.setTier(economy.state.machineTier);

  const workerManager = new WorkerManager(scene);

  // Kazdy z 10 slotow rankingu Top 10 ma stala "role" (patrz WORKER_TYPE_DEFS).
  // Awatar pojawia sie w scenie dokladnie raz, gdy ktos zajmie dany slot.
  async function ensureWorkerType(slotIndex) {
    const def = WORKER_TYPE_DEFS[slotIndex];
    if (!def) return;
    await workerManager.addWorkerType(slotIndex, def.modelKey);
  }

  const coinPool = new CoinPool(scene);
  await coinPool.init();

  const goldCoin = new GoldenCoinManager(scene, machine, (point) => {
    const bonus = economy.collectGoldenCoin();
    coinPool.burst(point, bonus);
    projectAndFloat(point, `+${fmtShort(bonus)} zł!`, { gold: true });
    save();
  });
  await goldCoin.init();

  const vanessa = new VanessaManager(
    scene,
    camera,
    machine,
    economy,
    coinPool,
    (point, text, opts) => {
      projectAndFloat(point, text, opts);
    },
    (username, reward, color) => {
      // Nagroda za przepedzenie Vanessy to odzyskana kwota, NIE swiezy
      // zarobek - inaczej dodrukowalibysmy pieniadze (patrz kickChat).
      kickChat.creditRecoveredMoney(username, reward, color);
    }
  );
  await vanessa.init();

  // Panel z logiem zdarzen Vanessy - kazde zdarzenie dopisuje sie na biezaco.
  const vanessaLogUI = new VanessaLogUI(vanessa);
  vanessa.onLog = (entry) => {
    if (entry === null) vanessaLogUI.renderAll([]);
    else vanessaLogUI.append(entry);
  };

  const spawnVanessaBtn = document.getElementById('btn-spawn-vanessa');
  if (spawnVanessaBtn) {
    spawnVanessaBtn.addEventListener('click', () => {
      vanessa.spawn(true);
    });
  }

  function save() {
    economy.save();
    kickChat.flush();
  }

  const clock = new THREE.Clock();
  const machineBurstOrigin = new THREE.Vector3(0, 0.6, 0.3);

  // Wspolny baner awansu bankomatu - uzywany zarowno przy zwyklym awansie,
  // jak i po pokonaniu bossa (patrz onDefeated ponizej), zeby tekst zyl w JEDNYM miejscu.
  function announceTierAdvance(tier) {
    const def = MACHINE_TIERS[tier];
    showTopAnnouncement(
      '🎰 AWANS BANKOMATU!',
      `Czat wbił już <strong>${economy.state.totalChatClicks}</strong> klików - bankomat awansuje na <strong>${def.name}</strong> (×${def.mult} zarobku)!`,
      3400,
    );
  }

  const boss = new BossManager(
    scene,
    camera,
    controls,
    machine,
    economy,
    coinPool,
    (point, text, opts) => {
      projectAndFloat(point, text, opts);
    },
  );
  await boss.init();

  const spawnBossBtn = document.getElementById('btn-spawn-boss');
  if (spawnBossBtn) {
    spawnBossBtn.addEventListener('click', () => {
      boss.start(1, { force: true });
    });
  }

  const kickUI = new KickUI();
  const leaderboardUI = new LeaderboardUI();
  const workerOverlays = new WorkerOverlayManager();
  let ui;

  let isSyncingLeaderboard = false;
  let hasQueuedSync = false;

  // Uwaga (naprawa deadlocka): flaga isSyncingLeaderboard NIGDY nie moze
  // zostac zablokowana na true. Caly korpus idzie przez try/catch/finally,
  // blad pojedynczego slotu (np. chwilowy blad sieci przy ladowaniu modelu)
  // jest lapany osobno i tylko logowany, a kolejne zapytania o sync sa
  // obslugiwane petla `while`, NIE rekurencyjnym wywolaniem z `finally`
  // (rekurencja pod nieudanym promise'em uciekala jako unhandled rejection
  // i zostawiala flage zablokowana).
  async function syncLeaderboardAndOverlays() {
    if (isSyncingLeaderboard) {
      hasQueuedSync = true;
      return;
    }
    isSyncingLeaderboard = true;
    try {
      do {
        hasQueuedSync = false;
        try {
          kickChat.updateAssignments();
          for (let slot = 0; slot < 10; slot++) {
            try {
              const user = kickChat.getUserForWorker(slot);
              workerOverlays.updateWorkerUser(slot, user);
              if (user) {
                await ensureWorkerType(slot);
              }
            } catch (slotErr) {
              // Blad pojedynczego slotu (np. zerwane polaczenie przy ladowaniu
              // modelu postaci) nie moze przerwac przetwarzania pozostalych slotow.
              console.error(`[sync] Blad przy synchronizacji slotu ${slot}:`, slotErr);
            }
          }
          leaderboardUI.render(kickChat.getTopEarners(10), (s) => WORKER_TYPE_DEFS[s]?.name, kickChat);
        } catch (err) {
          console.error('[sync] Blad synchronizacji rankingu i awatarow:', err);
        }
      } while (hasQueuedSync);
    } finally {
      isSyncingLeaderboard = false;
    }
  }

  const kickChat = new KickChatClient({
    chatroomId: 37663,
    channelName: 'patiro',
    onStatusChange: ({ status, message, stats }) => {
      kickUI.updateStatus(status, message);
      kickUI.updateKliksCount(stats.kliksReceived);
    },
    onMessage: (msg) => {
      kickUI.addMessage(msg);
      // Sprawdzenie czy widz na czacie napisał sekretne hasło Vanessy
      vanessa.checkChatWord(msg.content, msg.username, msg.color);
      // Odpowiedzi na dzialania matematyczne bossa oraz komenda "pomoc" (omdlenia)
      boss.onChatMessage(msg.username, msg.content, msg.color);
    },
    onTopWorkerChat: ({ workerIndex, content }) => {
      const clean = (content || '')
        .replace(/(?:^|\s)[!/]*klik+[!.,?*~]*(?=\s|$)/gi, '')
        .replace(/(?:^|\s)[!/]*click+[!.,?*~]*(?=\s|$)/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (!clean) return;

      workerOverlays.showSpeechBubble(workerIndex, clean);
      const entry = workerManager.getWorkerType(workerIndex);
      if (entry) {
        workerManager.triggerInteract(entry);
      }
    },
    onKlik: async (sender) => {
      const nick = sender.username || 'Widz';

      // Omdlony przez bossa widz nie moze klikac - jego komenda jest w calosci
      // ignorowana (bez kasy, bez licznika klikow, bez wplywu na prog tieru).
      if (boss.isFainted(nick)) {
        return;
      }

      const { value, isCrit, tierAdvanced } = economy.performClick(performance.now(), true);
      machine.triggerClickAnim();
      coinPool.burst(machineBurstOrigin, value);
      const text = isCrit ? `KRYT! +${fmtShort(value)} (@${nick})` : `+${fmtShort(value)} (@${nick})`;
      projectAndFloat(machineBurstOrigin, text, { crit: isCrit, kick: true });
      kickUI.updateKliksCount(kickChat.stats.kliksReceived);

      // Jeśli klikający widz ma przypisanego pracownika, wywołujemy również jego animację uderzenia w bankomat
      const assignedSlot = kickChat.getWorkerForUser(nick);
      if (assignedSlot !== null) {
        const entry = workerManager.getWorkerType(assignedSlot);
        if (entry) {
          workerManager.triggerInteract(entry);
        }
      }

      // Rejestracja wygenerowanego zarobku w rankingu widzów (automatycznie wywołuje onLeaderboardUpdate)
      kickChat.recordEarned(nick, value, sender.identity?.color);

      // Automatyczny awans tieru automatu - gdy laczna liczba klikniec z czatu
      // przekroczy kolejny prog (patrz MACHINE_TIER_CLICK_THRESHOLDS w economy.js).
      if (tierAdvanced !== null) {
        const def_ = BOSS_DEFS[tierAdvanced];
        const alreadyDefeated = economy.state.bossesDefeated.includes(tierAdvanced);
        if (def_ && !alreadyDefeated) {
          // Boss przejmuje kontrole - awans bankomatu i baner wykonaja sie
          // dopiero po pokonaniu go (patrz onDefeated w setContext powyzej).
          boss.start(tierAdvanced);
        } else {
          await machine.setTier(tierAdvanced);
          announceTierAdvance(tierAdvanced);
          save();
        }
      }
    },
    onLeaderboardUpdate: () => {
      syncLeaderboardAndOverlays().catch((err) => {
        console.error('[sync] Nieobsluzony blad w syncLeaderboardAndOverlays (onLeaderboardUpdate):', err);
      });
    },
  });
  vanessa.setContext({ workerManager, kickChat });
  boss.setContext({
    workerManager,
    workerOverlays,
    kickChat,
    vanessa,
    onDefeated: async (tier) => {
      await machine.setTier(tier);
      announceTierAdvance(tier);
      showTopAnnouncement(
        '🏆 KAMIL KOVALENKO POKONANY!',
        `Boss <strong>${boss.def ? boss.def.name : 'Kamil Kovalenko'}</strong> został pokonany przez czat! Bankomat wraca do gry na nowym tierze.`,
        3200,
      );
      if (!economy.state.bossesDefeated.includes(tier)) {
        economy.state.bossesDefeated.push(tier);
      }
      save();
    },
  });
  try {
    await syncLeaderboardAndOverlays();
  } catch (err) {
    console.error('[sync] Nieobsluzony blad w syncLeaderboardAndOverlays (start):', err);
  }
  kickChat.connect();

  ui = new UI(economy, {
    onReset: async () => {
      economy.reset();
      kickChat.reset();
      kickUI.updateKliksCount(0);
      workerOverlays.clear();
      workerManager.clear();
      vanessa.reset();
      boss.reset();
      await machine.setTier(0);
      try {
        await syncLeaderboardAndOverlays();
      } catch (err) {
        console.error('[sync] Nieobsluzony blad w syncLeaderboardAndOverlays (onReset):', err);
      }
      save();
    },
  });

  const projected = new THREE.Vector3();
  function projectAndFloat(point, text, opts) {
    projected.copy(point);
    projected.project(camera);
    const rect = canvas.getBoundingClientRect();
    const sx = rect.left + (projected.x * 0.5 + 0.5) * rect.width;
    const sy = rect.top + (-projected.y * 0.5 + 0.5) * rect.height;
    ui.spawnFloater(text, sx, sy, opts);
  }

  machine.onClickHit = (point) => {
    // Klik streamera bezposrednio w model 3D - dolicza kase do wspolnej puli,
    // ale NIE liczy sie do progu awansu tieru (ten napedza wylacznie czat).
    const { value, isCrit } = economy.performClick(performance.now(), false);
    coinPool.burst(point, value);
    const text = isCrit ? `KRYT! +${fmtShort(value)}` : `+${fmtShort(value)}`;
    projectAndFloat(point, text, { crit: isCrit });
  };

  // Ekspozycja do debugowania/weryfikacji w konsoli przeglądarki.
  window.__game = {
    economy,
    machine,
    workerManager,
    coinPool,
    goldCoin,
    vanessa,
    boss,
    ui,
    kickChat,
    kickUI,
    leaderboardUI,
    workerOverlays,
    vanessaLogUI,
    syncLeaderboardAndOverlays,
    save,
  };

  function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(0.1, clock.getDelta());

    // W trakcie cutscenki bossa kamera jest w pelni pod jego kontrola -
    // controls.update() nadpisalby recznie ustawiona pozycje (OrbitControls
    // zawsze przelicza kamere z wewnetrznego stanu sferycznego, ignorujac
    // reczne zmiany camera.position).
    if (!boss.isCameraLocked()) {
      controls.update();
    }
    vanessa.paused = boss.isActive();
    machine.update(delta);
    workerManager.update(delta);
    coinPool.update(delta);
    goldCoin.update(delta);

    // Brak dochodu pasywnego - zl powstaja WYLACZNIE z klikniec.
    // Awatary Top 10 animuja sie tylko wtedy, gdy ich widz naprawde napisze
    // "klik" na czacie (obsluga w onKlik ponizej), wiec animacja zawsze
    // odpowiada realnemu klikniecu, a nie tyka sama z siebie.

    // Ceny i wyszarzenie przyciskow odswiezaja sie w refreshNumbers (co 100 ms)
    // bez przebudowy DOM.
    ui.refreshNumbers(performance.now());

    const canvasRect = canvas.getBoundingClientRect();

    // Aktualizacja złodziejki Vanessy (ruch, animacja, kradzież, rzutowanie dymków i plakietki)
    vanessa.update(delta, camera, canvasRect);

    // Aktualizacja bossa (cutscenka, walka matematyczna, omdlenia, rzutowanie plakietki i dymka)
    boss.update(delta, camera, canvasRect);

    // Aktualizacja pozycji plakietek z nickami i dymków czatu nad głowami pracowników w rzucie 3D -> 2D
    workerOverlays.updatePositions(workerManager.entries, camera, canvasRect);

    renderer.render(scene, camera);
  }
  animate();

  setInterval(save, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
  window.addEventListener('beforeunload', save);
}

main().catch((err) => {
  console.error('Blad startu gry:', err);
});
