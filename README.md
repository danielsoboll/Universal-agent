# General Agent

Interner Universal Knowledge Analyzer (eigenständiges Projekt).

## Setup

```bash
npm install
cp .env.example .env.local   # Werte aus Supabase Dashboard / CLI
npm run dev
```

## Supabase

- Project ref: `pkcucpsrwgactejovdmp`
- Migration: `supabase/migrations/20260729000100_init_schema.sql`
- Seed: `supabase/seed.sql` (einmalig serverseitig)
- Security: `docs/SECURITY_REVIEW.md`
- Phase-1-Bericht: `docs/PHASE1_REPORT.md`

## Scripts

```bash
npx tsx scripts/security-tests.ts
npm run build
```

## Hinweis

Internes Testsystem. Keine DGL-Produktivdaten ohne organisatorische Freigabe.
