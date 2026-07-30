/**
 * Stellt sicher: d.soboll@web.de = general_admin + Module + Kundenprojekt.
 * Auth-User muss bereits existieren.
 *
 * Run: npm run admin:ensure-dsoboll
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  try {
    const text = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]!]) {
        process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
      }
    }
  } catch {
    /* ignore */
  }
}

loadEnv();

const EMAIL = "d.soboll@web.de";
const CUSTOMER_ID = "e1111111-1111-4111-8111-111111111101";
const CUSTOMER_SLUG = "general-agent";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const service =
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
  }

  const admin = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const listed = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listed.error) throw listed.error;
  const user = listed.data.users.find(
    (u) => (u.email ?? "").toLowerCase() === EMAIL.toLowerCase(),
  );
  if (!user) {
    console.error(
      `FAIL: ${EMAIL} fehlt in Auth. Bitte im Supabase Dashboard anlegen.`,
    );
    process.exit(2);
  }

  const steps: Array<[string, { error: { message: string } | null }]> = [];

  steps.push([
    "platform_admins",
    await admin.from("platform_admins").upsert({
      user_id: user.id,
      created_by: user.id,
    }),
  ]);

  steps.push([
    "customers",
    await admin.from("customers").upsert(
      {
        id: CUSTOMER_ID,
        slug: CUSTOMER_SLUG,
        name: "General Agent",
        status: "onboarding",
        description: "Standardprojekt",
        landscape_label: "Intern",
        brand_subtitle: "Universal Knowledge Analyzer",
        created_by: user.id,
      },
      { onConflict: "slug" },
    ),
  ]);

  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("slug", CUSTOMER_SLUG)
    .single();

  steps.push([
    "customer_memberships",
    await admin.from("customer_memberships").upsert(
      {
        customer_id: customer!.id,
        user_id: user.id,
        role: "customer_admin",
        status: "active",
      },
      { onConflict: "customer_id,user_id" },
    ),
  ]);

  steps.push([
    "app_user_profiles",
    await admin.from("app_user_profiles").upsert(
      {
        user_id: user.id,
        role: "general_admin",
        customer_id: customer!.id,
        display_name: "Daniel Soboll",
        module_sap: true,
        module_homepage: true,
        module_database: true,
        active_module: "general",
      },
      { onConflict: "user_id" },
    ),
  ]);

  for (const [name, res] of steps) {
    if (res.error) {
      console.error(`FAIL ${name}:`, res.error.message);
      console.error("→ Migrationen 20260731* zuerst anwenden.");
      process.exit(3);
    }
    console.log(`OK  ${name}`);
  }

  console.log(`\nProfil bereit für ${EMAIL}`);
  console.log(`  role: general_admin`);
  console.log(`  modules: sap + homepage + database`);
  console.log(`  customer: ${CUSTOMER_SLUG}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
