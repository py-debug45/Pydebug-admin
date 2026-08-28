// supabaseClient.js
// Loads the Supabase JS SDK from CDN (included via <script> tag in every HTML page)
// and creates one shared client that every other JS file can use.

const SUPABASE_URL = "https://cztosbchfqtyzxkhfrby.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6dG9zYmNoZnF0eXp4a2hmcmJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4OTIwNDMsImV4cCI6MjEwMDQ2ODA0M30.bnG0L2_aOXHBCkxty084PZ4P6EmK_LDtVan_tbQ4si8";

// `supabase` here is the global object injected by the CDN script:
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//
// If that CDN request was blocked (offline, ad-blocker, corporate proxy) the
// global doesn't exist. Previously that threw "supabase is not defined" and
// every page rendered as a blank shell with no explanation. Now we fail loudly
// and visibly instead.
if (typeof supabase === "undefined" || typeof supabase.createClient !== "function") {
  const message =
    "Could not load the Supabase library from the CDN. Check your internet " +
    "connection (or an ad-blocker / content blocker) and reload the page.";

  const showFatal = () => {
    const banner = document.createElement("div");
    banner.setAttribute("role", "alert");
    banner.style.cssText =
      "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;" +
      "justify-content:center;padding:24px;text-align:center;background:#0b0e14;" +
      "color:#f2545b;font-family:system-ui,sans-serif;font-size:0.95rem;line-height:1.6";
    banner.textContent = message;
    document.body.appendChild(banner);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", showFatal);
  } else {
    showFatal();
  }

  console.error("supabaseClient:", message);
  throw new Error(message);
}

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Expose it globally so every page script (auth.js, dashboard.js, etc.)
// can just use `sb` directly without re-importing.
window.sb = sb;
