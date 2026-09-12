import { pobierzStan, zapiszStan, usunStan, czyAdmin, kvSkonfigurowane } from './_kv.js';

// Stan gry trzymany po stronie serwera - wspolny dla wszystkich, kto otworzy
// adres gry. Zapis i kasowanie wymagaja hasla admina (ADMIN_TOKEN), odczyt jest
// publiczny, zeby widzowie mogli ogladac aktualny stan w trybie tylko do odczytu.
//
//   GET    /api/state  -> { ok, stan }         (publiczne)
//   POST   /api/state  -> zapis calego stanu    (tylko admin)
//   DELETE /api/state  -> kasowanie stanu       (tylko admin, uzywane przy resecie)

const LIMIT_BAJTOW = 512 * 1024; // zdroworozsadkowy limit na jeden zapis

export default async function handler(req, res) {
  if (!kvSkonfigurowane()) {
    return res.status(503).json({
      ok: false,
      blad: 'Magazyn KV nie jest skonfigurowany (brak zmiennych KV_REST_API_* ani UPSTASH_REDIS_REST_*).',
    });
  }

  try {
    if (req.method === 'GET') {
      const stan = await pobierzStan();
      // Wszyscy widzowie pytaja o DOKLADNIE ten sam obiekt, wiec pozwalamy CDN
      // Vercela scalic te zapytania. Bez tego koszt rosnie liniowo z widownia
      // (200 widzow x 4 h = ~288 tys. odczytow Redisa) i darmowy limit Upstash
      // konczy sie w trakcie streamu. Z s-maxage do funkcji dociera najwyzej
      // 12 zapytan na minute NIEZALEZNIE od liczby widzow.
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5, stale-while-revalidate=10');
      return res.status(200).json({ ok: true, stan });
    }

    if (req.method === 'POST') {
      if (!czyAdmin(req)) return res.status(401).json({ ok: false, blad: 'Brak uprawnien admina' });

      const stan = req.body;
      if (!stan || typeof stan !== 'object' || Array.isArray(stan)) {
        return res.status(400).json({ ok: false, blad: 'Oczekiwano obiektu ze stanem gry' });
      }
      const rozmiar = Buffer.byteLength(JSON.stringify(stan), 'utf8');
      if (rozmiar > LIMIT_BAJTOW) {
        return res.status(413).json({ ok: false, blad: `Stan za duzy (${rozmiar} B)` });
      }

      await zapiszStan({ ...stan, zapisano: Date.now() });
      return res.status(200).json({ ok: true, rozmiar });
    }

    if (req.method === 'DELETE') {
      if (!czyAdmin(req)) return res.status(401).json({ ok: false, blad: 'Brak uprawnien admina' });
      await usunStan();
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ ok: false, blad: 'Niedozwolona metoda' });
  } catch (err) {
    console.error('[api/state] Blad:', err);
    return res.status(500).json({ ok: false, blad: 'Blad magazynu stanu' });
  }
}
