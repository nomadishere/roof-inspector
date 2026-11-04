// Roof Inspector — share links. Hands out a one-time signed upload URL so the
// browser can save a finished report; reports are then readable by link only.
import { createClient } from "npm:@supabase/supabase-js@2";

const PER_IP_SHARES_PER_DAY = 30;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function newId() {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => a[x % a.length]).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const { count } = await db.from("ri_shares").select("id", { count: "exact", head: true }).eq("ip", ip).gte("created_at", dayAgo);
  if ((count || 0) >= PER_IP_SHARES_PER_DAY) return json({ error: "LIMIT", message: "Too many share links today. Try again tomorrow." }, 429);

  const id = newId();
  const { data, error } = await db.storage.from("ri-reports").createSignedUploadUrl(`r/${id}.json`);
  if (error || !data) return json({ error: "STORAGE", message: "Couldn't create a share link. Please try again." }, 500);
  await db.from("ri_shares").insert({ id, ip });
  return json({ id, path: data.path, token: data.token, signedUrl: data.signedUrl });
});
