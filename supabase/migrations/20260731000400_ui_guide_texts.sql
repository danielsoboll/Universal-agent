-- UI guidance texts shown next to action buttons (German).
-- Editable in Supabase without redeploying hard-coded copy.

create table if not exists public.ui_guide_texts (
  id uuid primary key default gen_random_uuid(),
  guide_key text not null unique,
  surface text not null default 'general',
  title text not null,
  body text not null,
  sort_order int not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger ui_guide_texts_set_updated_at
  before update on public.ui_guide_texts
  for each row execute function public.set_updated_at();

alter table public.ui_guide_texts enable row level security;

create policy ui_guide_texts_select on public.ui_guide_texts
  for select to authenticated
  using (enabled = true or public.is_platform_admin());

create policy ui_guide_texts_write on public.ui_guide_texts
  for all to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

insert into public.ui_guide_texts (guide_key, surface, title, body, sort_order) values
(
  'home.admin',
  'home',
  'Was ist zu tun?',
  'Öffnen Sie den Admin-Bereich, um einen Kunden anzulegen, Ziele und Datenquellen zu wählen und den Onboarding-Fahrplan abzuarbeiten. Ohne Admin-Rechte erscheint eine Erklärung zum Zugriff.',
  10
),
(
  'home.app',
  'home',
  'Was ist zu tun?',
  'Der Anwenderbereich dient später der Suche. Nutzen Sie ihn erst, nachdem im Admin-Fahrplan die Freigabe abgeschlossen wurde.',
  20
),
(
  'home.new_project',
  'home',
  'Was ist zu tun?',
  'Legt ein klassisches Knowledge-Unit-Projekt an (Quellen hochladen, chatten). Parallel zum neuen Admin-Onboarding.',
  30
),
(
  'admin.dashboard.setup',
  'admin_dashboard',
  'Was ist zu tun?',
  'Starten oder setzen Sie den Setup-Assistenten fort: Kunde → Ziele → Adapter → Konfiguration → Fahrplan erzeugen.',
  10
),
(
  'admin.dashboard.checklist',
  'admin_dashboard',
  'Was ist zu tun?',
  'Gehen Sie zum Fahrplan und erledigen Sie den nächsten bereiten Schritt (Checkbox, Upload oder Pipeline).',
  20
),
(
  'admin.setup.step1_create',
  'admin_setup',
  'Was ist zu tun?',
  'Tragen Sie Projektname und kurze Beschreibung ein. Optional: Slug und System-/Landschaftsbezeichnung. Danach legen Sie den Kunden an.',
  10
),
(
  'admin.setup.step2_goals',
  'admin_setup',
  'Was ist zu tun?',
  'Wählen Sie eine oder mehrere Zielsetzungen. Die Infotexte erklären Bedeutung, Ergebnisse und typische Quellen. Speichern und weiter.',
  20
),
(
  'admin.setup.step3_adapters',
  'admin_setup',
  'Was ist zu tun?',
  'Wählen Sie die benötigten Input-Adapter (z. B. Repository und Steuertabellen). Nur verfügbare Adapter sind aktiv nutzbar.',
  30
),
(
  'admin.setup.step4_config',
  'admin_setup',
  'Was ist zu tun?',
  'Füllen Sie die adapterabhängigen Felder aus (System-ID, Mandant, Filter …). Pflichtfelder aus dem Schema möglichst vollständig setzen.',
  40
),
(
  'admin.setup.step5_generate',
  'admin_setup',
  'Was ist zu tun?',
  'Erzeugen Sie den Fahrplan deterministisch aus Zielen und Adaptern. Ein bestehender aktiver Fahrplan wird archiviert und neu aufgebaut.',
  50
),
(
  'admin.checklist.complete',
  'admin_checklist',
  'Was ist zu tun?',
  'Markieren Sie den Schritt als erledigt, sobald die Anweisung erfüllt ist (z. B. Export im Quellsystem durchgeführt). Erst bereite Schritte sind klickbar.',
  10
),
(
  'admin.checklist.pipeline',
  'admin_checklist',
  'Was ist zu tun?',
  'Legt einen Pipeline-Run mit Status „ready“ an. Es wird kein automatischer Erfolg gemeldet — der echte Lauf erfolgt später über die Pipeline/CLI.',
  20
),
(
  'admin.users.invite',
  'admin_users',
  'Was ist zu tun?',
  'Tragen Sie E-Mail (Notiz) und die Auth-User-UUID eines bestehenden Nutzers ein. Rolle „customer_user“ für Suche, „customer_admin“ für Onboarding.',
  10
),
(
  'app.search',
  'app',
  'Was ist zu tun?',
  'Nach Admin-Freigabe können Sie hier suchen. Solange der Banner „Noch nicht freigegeben“ sichtbar ist, bleibt die Suche deaktiviert.',
  10
),
(
  'login.submit',
  'login',
  'Was ist zu tun?',
  'Mit Ihrer internen Test-E-Mail und dem Passwort anmelden. Nach dem Login gelangen Sie zur Startseite mit Admin- und Anwenderbereich.',
  10
)
on conflict (guide_key) do update set
  surface = excluded.surface,
  title = excluded.title,
  body = excluded.body,
  sort_order = excluded.sort_order,
  enabled = true,
  updated_at = now();
