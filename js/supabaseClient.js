// supabaseClient.js
// Creates the single shared Supabase client used by every other script.
//
// The SDK itself is served from this origin (js/vendor/supabase.min.js) with a
// CDN fallback handled by js/admin-boot.js, so a blocked/slow CDN can no
// longer take the whole panel down. This file is defensive on purpose: it
// never throws at parse time, because a throw here used to kill every script
// that came after it.

const SUPABASE_URL = "https://cztosbchfqtyzxkhfrby.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6dG9zYmNoZnF0eXp4a2hmcmJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4OTIwNDMsImV4cCI6MjEwMDQ2ODA0M30.bnG0L2_aOXHBCkxty084PZ4P6EmK_LDtVan_tbQ4si8";

// `var` (not `const`) so the client can be created later by admin-boot.js if
// the local bundle had to fall back to the CDN.
var sb = window.sb || null;

function initSupabaseClient() {
  if (window.sb) {
    sb = window.sb;
    return sb;
  }
  if (!window.supabase || typeof window.supabase.createClient !== "function") return null;
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    // The dashboard only needs a trickle of presence events; throttling the
    // socket keeps a busy site from flooding the admin tab with re-renders.
    realtime: { params: { eventsPerSecond: 4 } },
  });
  window.sb = sb;
  return sb;
}

window.initSupabaseClient = initSupabaseClient;
initSupabaseClient();
