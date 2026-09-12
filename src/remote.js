// Stan gry trzymany na serwerze (Vercel KV) + logowanie admina.
//
// Zasady:
// - Odczyt stanu jest publiczny - kazdy, kto otworzy adres gry, widzi aktualny
//   stan (tryb widza, tylko do odczytu).
// - Zapis i kasowanie wymagaja hasla admina. Haslo idzie w naglowku
//   Authorization i jest trzymane w localStorage tej jednej przegladarki.
// - Gdy API nie odpowiada (np. lokalne uruchomienie przez serve.py, bez
//   Vercela), gra dziala jak dotad: stan w localStorage i PELNE uprawnienia.
//   Dzieki temu praca lokalna niczego nie wymaga.

const KLUCZ_TOKENU = 'bankomat-clicker-admin-token';

export class RemoteState {
  constructor() {
    this.token = null;
    try {
      this.token = localStorage.getItem(KLUCZ_TOKENU);
    } catch (_) {}
    // null = jeszcze nie wiadomo, true/false = ustalone przy pierwszym zapytaniu
    this.dostepne = null;
    this.zalogowany = false;
  }

  /** Czy backend stanu w ogole odpowiada (na Vercelu tak, lokalnie zwykle nie). */
  czyOnline() {
    return this.dostepne === true;
  }

  /**
   * Uprawnienia do resetu i spawnowania. Offline (brak API) = pelne uprawnienia,
   * bo wtedy gra i tak zyje tylko w tej jednej przegladarce.
   */
  czyAdmin() {
    if (this.dostepne === false) return true;
    return this.zalogowany;
  }

  _naglowki(dodatkowe = {}) {
    const h = { ...dodatkowe };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /** Pierwszy kontakt z serwerem - ustala dostepnosc API i odswieza status admina. */
  async zainicjuj() {
    const stan = await this.pobierz();
    if (this.dostepne && this.token) {
      this.zalogowany = await this.sprawdzToken(this.token);
      if (!this.zalogowany) this.wyloguj();
    }
    return stan;
  }

  /** Pobiera stan gry z serwera. Zwraca null, gdy brak stanu albo brak API. */
  async pobierz() {
    try {
      const odp = await fetch('/api/state', { headers: { Accept: 'application/json' } });
      if (!odp.ok) {
        // 503 = API dziala, ale magazyn nieskonfigurowany. Kazdy inny blad tez
        // traktujemy jako "brak backendu" i schodzimy na localStorage.
        this.dostepne = false;
        return null;
      }
      const dane = await odp.json();
      this.dostepne = true;
      return dane && dane.ok ? dane.stan : null;
    } catch (_) {
      this.dostepne = false;
      return null;
    }
  }

  async sprawdzToken(token) {
    try {
      const odp = await fetch('/api/login', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      return odp.ok;
    } catch (_) {
      return false;
    }
  }

  /** Logowanie admina. Zwraca true przy poprawnym hasle. */
  async zaloguj(token) {
    const czyste = (token || '').trim();
    if (!czyste) return false;
    const ok = await this.sprawdzToken(czyste);
    if (!ok) return false;
    this.token = czyste;
    this.zalogowany = true;
    this.dostepne = true;
    try {
      localStorage.setItem(KLUCZ_TOKENU, czyste);
    } catch (_) {}
    return true;
  }

  wyloguj() {
    this.token = null;
    this.zalogowany = false;
    try {
      localStorage.removeItem(KLUCZ_TOKENU);
    } catch (_) {}
  }

  /** Zapis stanu na serwer. Tylko admin; poza tym cicho pomijane. */
  async zapisz(stan) {
    if (!this.czyOnline() || !this.zalogowany) return false;
    try {
      const odp = await fetch('/api/state', {
        method: 'POST',
        headers: this._naglowki({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(stan),
      });
      if (odp.status === 401) {
        // Haslo przestalo byc wazne (np. zmienione na Vercelu) - wylogowujemy.
        this.wyloguj();
        return false;
      }
      return odp.ok;
    } catch (_) {
      return false;
    }
  }

  /** Kasowanie stanu na serwerze - uzywane przy resecie gry. */
  async wyczysc() {
    if (!this.czyOnline() || !this.zalogowany) return false;
    try {
      const odp = await fetch('/api/state', { method: 'DELETE', headers: this._naglowki() });
      return odp.ok;
    } catch (_) {
      return false;
    }
  }
}

export const remote = new RemoteState();
