// Klient kanalu realtime (WebSocket) dla synchronizacji miedzy karta
// wlasciciela a kartami widzow. To jest DODATKOWA warstwa nad istniejacym
// zapisem/odczytem z Vercel KV (patrz src/remote.js) - gdy serwer relay jest
// niedostepny albo wylaczony, gra ma dzialac DOKLADNIE tak jak dzis (KV +
// odpytywanie co 10 s). Zaden blad tego modulu nie moze przerwac startu gry
// ani zasypac konsoli.

// JEDYNE miejsce do edycji przy wdrozeniu serwera relay. Pusty string =
// funkcja realtime jest wylaczona i gra dziala jak dotychczas (KV + odpytywanie).
//
// Musi byc wss:// (nie ws://) - strona na Vercelu chodzi po https, a przegladarki
// blokuja niezaszyfrowane polaczenia z takiej strony.
//
// Uwaga: darmowy plan Rendera usypia usluge po ok. 15 minutach bezczynnosci,
// wiec pierwsze polaczenie po przerwie moze trwac kilkadziesiat sekund. Gra
// dziala w tym czasie na zapasowym odpytywaniu /api/state i przelacza sie na
// realtime sama, gdy przekaznik wstanie.
export const URL_RELAYA = 'wss://bankomat-relay.onrender.com';

const OPOZNIENIE_START_MS = 1000;
const OPOZNIENIE_MAX_MS = 15000;

export class Realtime {
  constructor({ url, rola, token } = {}) {
    this.url = url || URL_RELAYA;
    this.rola = rola === 'host' ? 'host' : 'widz';
    this.token = token || null;

    this.ws = null;
    this.polaczonyFlag = false;
    this.hostOnlineFlag = false;
    this.zamkniete = false; // ustawiane przez rozlacz() - blokuje auto-reconnect
    this._opoznienie = OPOZNIENIE_START_MS;
    this._reconnectTimer = null;
    this._ostrzezonoOBraku = false;

    this.onSnapshot = () => {};
    this.onZdarzenie = () => {};
    this.onStatus = () => {};
  }

  _budujUrl() {
    let baza = this.url;
    if (!baza.includes('://')) {
      // Bezpieczny fallback, gdyby ktos podal adres bez protokolu.
      const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws';
      baza = `${proto}://${baza}`;
    }
    const sep = baza.includes('?') ? '&' : '?';
    let pelny = `${baza}${sep}rola=${this.rola}`;
    if (this.rola === 'host' && this.token) {
      pelny += `&token=${encodeURIComponent(this.token)}`;
    }
    return pelny;
  }

  polacz() {
    if (!this.url) {
      // Funkcja wylaczona (brak adresu) - cicho nic nie robimy, gra dziala
      // dalej na dotychczasowym mechanizmie KV + odpytywanie.
      return;
    }
    this.zamkniete = false;
    this._otworz();
  }

  _otworz() {
    if (this.zamkniete) return;
    let ws;
    try {
      ws = new WebSocket(this._budujUrl());
    } catch (err) {
      this._ostrzezJednorazowo(err);
      this._zaplanujReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return; // polaczenie juz zastapione/zamkniete - ignorujemy spozniony event
      this.polaczonyFlag = true;
      this._opoznienie = OPOZNIENIE_START_MS;
      this._zglosStatus();
    });

    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return; // patrz wyzej - spozniony event z nieaktualnego polaczenia
      let wiadomosc;
      try {
        wiadomosc = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (!wiadomosc || typeof wiadomosc !== 'object') return;

      if (wiadomosc.typ === 'snapshot') {
        this.onSnapshot(wiadomosc.dane);
      } else if (wiadomosc.typ === 'zdarzenie') {
        this.onZdarzenie(wiadomosc.nazwa, wiadomosc.dane);
      } else if (wiadomosc.typ === 'host-online') {
        this.hostOnlineFlag = true;
        this._zglosStatus();
      } else if (wiadomosc.typ === 'host-offline' || wiadomosc.typ === 'brak-hosta') {
        this.hostOnlineFlag = false;
        this._zglosStatus();
      } else if (wiadomosc.typ === 'zly-token') {
        // Serwer odrzucil nas jako hosta - HOST_TOKEN na przekazniku nie zgadza
        // sie z ADMIN_TOKEN uzytym przez ta karte. Kod zamkniecia 4001 nie
        // przechodzi przez proxy hostingow (Render zamienia go na 1006), wiec
        // serwer wysyla najpierw te ramke - inaczej blad bylby nie do
        // odroznienia od zwyklej awarii sieci i karta ponawialaby w nieskonczonosc
        // bez slowa wyjasnienia.
        this.zlyToken = true;
        this.zamkniete = true; // nie ma sensu ponawiac - haslo sie nie zmieni samo
        console.error(
          '[realtime] Przekaznik odrzucil haslo hosta. HOST_TOKEN na serwerze relay musi byc IDENTYCZNY ' +
            'z ADMIN_TOKEN w projekcie na Vercelu. Synchronizacja w czasie rzeczywistym jest wylaczona - ' +
            'gra dziala dalej na zapasowym odpytywaniu /api/state.',
        );
        try {
          ws.close();
        } catch (_) {}
      } else if (wiadomosc.typ === 'zastapiony') {
        // Inny host przejal role (np. druga zalogowana karta wlasciciela).
        // Nie probujemy sie odlaczac agresywnie - po prostu przestajemy byc hostem.
        this.zamkniete = true;
        try {
          ws.close();
        } catch (_) {}
      }
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return; // zamkniecie nieaktualnego, juz zastapionego polaczenia - nic nie robimy
      const bylPolaczony = this.polaczonyFlag;
      this.polaczonyFlag = false;
      this.hostOnlineFlag = false;
      if (bylPolaczony || !this._ostrzezonoOBraku) {
        this._zglosStatus();
      }
      if (!this.zamkniete) {
        this._zaplanujReconnect();
      }
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      // 'close' i tak przyjdzie zaraz po 'error' dla WebSocket - tu tylko
      // cichy log pierwszego razu, zeby nie zasypac konsoli przy kazdej probie.
      this._ostrzezJednorazowo();
    });
  }

  _ostrzezJednorazowo(err) {
    if (this._ostrzezonoOBraku) return;
    this._ostrzezonoOBraku = true;
    console.warn('[realtime] Serwer relay niedostepny - dzialam w trybie zapasowym (KV/localStorage).', err || '');
  }

  _zaplanujReconnect() {
    if (this.zamkniete || this._reconnectTimer) return;
    const jitter = Math.random() * 400;
    const opoznienie = Math.min(this._opoznienie, OPOZNIENIE_MAX_MS) + jitter;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._opoznienie = Math.min(this._opoznienie * 2, OPOZNIENIE_MAX_MS);
      this._otworz();
    }, opoznienie);
  }

  _zglosStatus() {
    try {
      this.onStatus({ polaczony: this.polaczonyFlag, host: this.hostOnlineFlag });
    } catch (err) {
      console.warn('[realtime] Blad w callbacku onStatus:', err);
    }
  }

  rozlacz() {
    this.zamkniete = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.polaczonyFlag = false;
    this.hostOnlineFlag = false;
  }

  czyPolaczony() {
    return this.polaczonyFlag;
  }

  /**
   * Zmiana roli/tokenu w locie (np. admin loguje/wylogowuje sie PO tym, jak
   * polaczenie realtime juz powstalo jako widz). Reconnectuje tylko wtedy,
   * gdy cos faktycznie sie zmienilo.
   */
  ustawRole({ rola, token } = {}) {
    const nowaRola = rola === 'host' ? 'host' : 'widz';
    const nowyToken = token || null;
    if (nowaRola === this.rola && nowyToken === this.token) return;
    this.rola = nowaRola;
    this.token = nowyToken;
    if (this.ws || this._reconnectTimer) {
      this.rozlacz();
      this.polacz();
    }
  }

  _wyslij(obiekt) {
    if (this.rola !== 'host') return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(obiekt));
    } catch (err) {
      console.warn('[realtime] Blad wysylki ramki:', err);
    }
  }

  wyslijSnapshot(dane) {
    this._wyslij({ typ: 'snapshot', dane });
  }

  wyslijZdarzenie(nazwa, dane) {
    this._wyslij({ typ: 'zdarzenie', nazwa, dane });
  }
}
