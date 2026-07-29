# Migrations — Ausführungsreihenfolge

| Reihenfolge | Datei | Phase | Status |
|---|---|---|---|
| 1 | `supabase/migrations/20260729000100_init_schema.sql` | Phase 1 | angewendet (remote) |
| 2 | `supabase/seed.sql` | Phase 1 | angewendet (serverseitig) |
| 3 | Auth-Testuser | Phase 1 | manuell / Script |
| 4 | `supabase/planned/20260729000400_knowledge_units_hnsw.sql` | Phase 4 | geplant, nicht anwenden |

Kein `db push` ohne explizite Anweisung für weitere Migrationen.
