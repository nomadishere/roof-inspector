// Public settings (safe to be visible — the AI key lives only on the server).
export const SUPABASE_URL = "https://yrneifslwwrussqcjytj.supabase.co";
export const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlybmVpZnNsd3dydXNzcWNqeXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0ODAwMzcsImV4cCI6MjEwOTA1NjAzN30._RaYIVt7sgIwGvt5-h_waGPYlnwlaG7E0tuu0leZFkg";
export const FN = SUPABASE_URL + "/functions/v1/";
export const SHARE_BASE = SUPABASE_URL + "/storage/v1/object/public/ri-reports/r/";

export const SCAN_BUDGET = 56;   // max video stills sent for the AI scan
export const PHOTO_BUDGET = 12;  // max uploaded photos sent

export const FONTS = [
  { name: "Classic (Arial)", stack: "Arial,Helvetica,sans-serif", google: null },
  { name: "Inter", stack: "'Inter',Arial,sans-serif", google: "Inter:wght@400;700" },
  { name: "Montserrat", stack: "'Montserrat',Arial,sans-serif", google: "Montserrat:wght@400;700" },
  { name: "Lato", stack: "'Lato',Arial,sans-serif", google: "Lato:wght@400;700" },
  { name: "Roboto", stack: "'Roboto',Arial,sans-serif", google: "Roboto:wght@400;700" },
  { name: "Oswald (bold, narrow)", stack: "'Oswald',Arial,sans-serif", google: "Oswald:wght@400;700" },
  { name: "Merriweather (serif)", stack: "'Merriweather',Georgia,serif", google: "Merriweather:wght@400;700" },
  { name: "Playfair Display (elegant serif)", stack: "'Playfair Display',Georgia,serif", google: "Playfair+Display:wght@400;700" },
];

export const ROOF_TYPES = [
  { id: "Asphalt shingles", label: "Shingles" },
  { id: "EPDM (rubber membrane)", label: "EPDM" },
  { id: "Metal", label: "Metal" },
];
