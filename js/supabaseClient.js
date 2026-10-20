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

// Baseline options for every client this app builds.
const SUPABASE_CLIENT_OPTIONS = {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // The admin panel never receives magic links for normal login, so nothing
    // is parsed from the URL on page load. The password-recovery page is the
    // one exception and asks for its own client with this switched on.
    detectSessionInUrl: false,
  },
  // The dashboard only needs a trickle of presence events; throttling the
  // socket keeps a busy site from flooding the admin tab with re-renders.
  realtime: { params: { eventsPerSecond: 4 } },
};

// Builds an additional client (e.g. the recovery page needs
// detectSessionInUrl: true). Returns null when the SDK is unavailable instead
// of throwing, so the caller can show a readable message.
function createSupabaseClient(overrides) {
  if (!window.supabase || typeof window.supabase.createClient !== "function") return null;
  const options = Object.assign({}, SUPABASE_CLIENT_OPTIONS, overrides || {});
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, options);
}

function initSupabaseClient() {
  if (window.sb) {
    sb = window.sb;
    return sb;
  }
  sb = createSupabaseClient();
  if (!sb) return null;
  window.sb = sb;
  return sb;
}

window.createSupabaseClient = createSupabaseClient;
window.initSupabaseClient = initSupabaseClient;
initSupabaseClient();
