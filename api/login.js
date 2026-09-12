import { czyAdmin } from './_kv.js';

// Weryfikacja hasla admina. Klient wola to raz po wpisaniu hasla; samo haslo
// nigdy nie jest odsylane z serwera - sprawdzamy tylko, czy pasuje.
//
//   POST /api/login  (naglowek Authorization: Bearer <haslo>)  -> { ok }

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, blad: 'Niedozwolona metoda' });
  }
  if (!process.env.ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, blad: 'ADMIN_TOKEN nie jest ustawiony na serwerze' });
  }
  if (!czyAdmin(req)) {
    return res.status(401).json({ ok: false, blad: 'Bledne haslo' });
  }
  return res.status(200).json({ ok: true });
}
