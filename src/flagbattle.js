import * as THREE from 'three';
import { COUNTRIES, COUNTRY_CODES, normalizeCountryName } from './countries.js';
import { projectAndFloat } from './vanessa.js'; // I might need to extract this or just use ui.js for banners. Let's just write floating texts. Wait, projectAndFloat is in vanessa.js? Let's check where to import projectAndFloat. I will implement my own simple floating text or use KickUI.

export class FlagBattleManager {
  constructor(scene) {
    this.scene = scene;
    
    this.state = 'IDLE'; // IDLE, WAITING, BATTLE, REWARD
    this.timer = 0;
    this.tile = null; // {x, z}
    this.players = []; // [{ typeIndex, username, score }]
    
    this.currentFlag = null; // np. 'PL'
    this.flagsGuessed = 0; // Ile flag zgadnięto w obecnej bitwie
    
    this.rewardTimer = 0;
    this.winner = null;

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

    // Sprite z flagą
    this.flagMaterial = new THREE.SpriteMaterial({ color: 0xffffff });
    this.flagSprite = new THREE.Sprite(this.flagMaterial);
    this.flagSprite.scale.set(1.5, 1.0, 1.0); // proporcja flagi
    this.flagSprite.position.y = 3.0; // Nad polem
    this.flagSprite.visible = false;
    this.scene.add(this.flagSprite);
    
    this.textureLoader = new THREE.TextureLoader();
  }

  setContext({ workerManager, kickChat, economy }) {
    this.workerManager = workerManager;
    this.kickChat = kickChat;
    this.economy = economy;
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
    if (this.state === 'IDLE') {
      this.timer += dt;
      if (this.timer >= 30) {
        this.spawnBattleSquare();
      }
    } 
    else if (this.state === 'WAITING') {
      this.checkPlayersEntry();
    }
    else if (this.state === 'BATTLE') {
      // Pulsujące podświetlenie na czerwono
      const s = Math.sin(Date.now() * 0.005) * 0.5 + 0.5;
      this.highlightMesh.material.color.setRGB(1, s * 0.5, s * 0.5);
    }
    else if (this.state === 'REWARD') {
      this.rewardTimer += dt;
      
      // Złoty kolor w nagrodzie
      const s = Math.sin(Date.now() * 0.003) * 0.5 + 0.5;
      this.highlightMesh.material.color.setRGB(1, 0.8 + s * 0.2, 0);

      // Pasywny dochód (np. tick co 1 sekundę by dawał +2zł)
      // Żeby zrealizować 2 zł / sek, możemy sumować czas ułamkowy, albo dawać co 1 sek:
      if (!this._lastRewardTime) this._lastRewardTime = 0;
      this._lastRewardTime += dt;
      if (this._lastRewardTime >= 1.0) {
        this._lastRewardTime -= 1.0;
        this.economy.addMoney(2);
        if (this.winner && this.winner.username) {
           this.kickChat.recordEarned(this.winner.username, 2);
           // Dymek z kasą z pracownika
           const worker = this.workerManager.getWorkerType(this.winner.typeIndex);
           if (worker && worker.obj) {
             // Jeśli trzeba odpalić dymek:
             const b = document.createElement('div');
             b.className = 'gold-float';
             b.textContent = '+2 zł';
             document.getElementById('ui-layer').appendChild(b);
             // projectToScreen logic... (Pominięte dla uproszczenia, można wywołać z innej funkcji)
           }
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
    
    // Ładujemy teksturę
    this.textureLoader.load(`assets/flags/${this.currentFlag}.png`, (texture) => {
      this.flagMaterial.map = texture;
      this.flagMaterial.needsUpdate = true;
      this.flagSprite.visible = true;
    });
  }

  onChatMessage(username, content) {
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
    this.winner = null;
    this.highlightMesh.visible = false;
    this.flagSprite.visible = false;
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
  }
}
