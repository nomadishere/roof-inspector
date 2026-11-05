// Free accounts: email + password (instant, no confirmation email), private per user.
import { createClient } from "./vendor/supabase.js";
import { SUPABASE_URL, SUPABASE_ANON } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "roofInspector.auth" } });

export async function currentUser() { const { data } = await sb.auth.getSession(); return data.session?.user || null; }

// Create the account (instantly ready, no confirmation email), or sign in if this email already has one.
export async function createOrSignIn(email, password, extra = {}) {
  let created = false;
  const r = await fetch(SUPABASE_URL + "/functions/v1/ri-signup", { method: "POST", headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON }, body: JSON.stringify({ email, password, ...extra }) });
  const d = await r.json().catch(() => ({}));
  if (r.ok) created = true;
  else if (d.error !== "exists") throw new Error(d.error || "Couldn't create your account. Please try again.");
  const inn = await sb.auth.signInWithPassword({ email, password });
  if (inn.error) throw new Error(created ? friendly(inn.error.message) : "That email already has an account, and the password doesn't match. Use your password, or uncheck \"Create my free account\".");
  return { user: inn.data.user, created };
}
export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(friendly(error.message));
  return data.user;
}
export const signOut = () => sb.auth.signOut();
function friendly(m) {
  m = String(m || "");
  if (/invalid login/i.test(m)) return "Email or password is wrong.";
  if (/password/i.test(m) && /6|short|least/i.test(m)) return "Password needs at least 6 characters.";
  if (/email/i.test(m) && /invalid/i.test(m)) return "That email address doesn't look right.";
  if (/rate|too many/i.test(m)) return "Too many tries. Please wait a minute and try again.";
  return m || "Something went wrong with your account. Please try again.";
}

export async function saveProfile(user, { phone, company, brand }) {
  const row = { user_id: user.id, email: user.email, updated_at: new Date().toISOString() };
  if (phone !== undefined) row.phone = phone || null;
  if (company !== undefined) row.company = company || null;
  if (brand !== undefined) row.brand = brand;
  const { error } = await sb.from("ri_profiles").upsert(row);
  if (error) console.warn("profile save", error.message);
}
export async function loadProfile(user) {
  const { data } = await sb.from("ri_profiles").select("*").eq("user_id", user.id).maybeSingle();
  return data;
}

export async function saveReport(user, model, id) {
  const now = new Date().toISOString();
  if (!id) {
    const { data, error } = await sb.from("ri_reports").insert({ address: (model.job.address || "").slice(0, 300), client: (model.job.client || "").slice(0, 200) }).select("id").single();
    if (error) throw new Error("Couldn't save to your account.");
    id = data.id;
  } else {
    await sb.from("ri_reports").update({ address: (model.job.address || "").slice(0, 300), client: (model.job.client || "").slice(0, 200), updated_at: now, share_id: model.shareId || null }).eq("id", id);
  }
  const blob = new Blob([JSON.stringify(model)], { type: "application/json" });
  const { error } = await sb.storage.from("ri-user").upload(`${user.id}/${id}.json`, blob, { upsert: true, contentType: "application/json" });
  if (error) throw new Error("Couldn't save the report file to your account.");
  return id;
}
export async function listReports() {
  const { data, error } = await sb.from("ri_reports").select("id,address,client,created_at,updated_at").order("created_at", { ascending: false }).limit(200);
  if (error) throw new Error("Couldn't load your reports.");
  return data || [];
}
export async function openReport(user, id) {
  const { data, error } = await sb.storage.from("ri-user").download(`${user.id}/${id}.json`);
  if (error) throw new Error("Couldn't open that report.");
  return JSON.parse(await data.text());
}
export async function deleteReport(user, id) {
  await sb.storage.from("ri-user").remove([`${user.id}/${id}.json`]);
  await sb.from("ri_reports").delete().eq("id", id);
}
export async function saveLead({ email, phone, company }) {
  if (!email && !phone) return;
  await sb.from("ri_leads").insert({ email: email || null, phone: phone || null, company: company || null });
}

export async function sendReset(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) throw new Error(friendly(error.message));
}
export async function setNewPassword(password) {
  const { data, error } = await sb.auth.updateUser({ password });
  if (error) throw new Error(friendly(error.message));
  return data.user;
}
