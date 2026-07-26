// supabaseClient.js
// Loads the Supabase JS SDK from CDN (included via <script> tag in every HTML page)
// and creates one shared client that every other JS file can use.

const SUPABASE_URL = "https://cztosbchfqtyzxkhfrby.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6dG9zYmNoZnF0eXp4a2hmcmJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4OTIwNDMsImV4cCI6MjEwMDQ2ODA0M30.bnG0L2_aOXHBCkxty084PZ4P6EmK_LDtVan_tbQ4si8";

// `supabase` here is the global object injected by the CDN script:
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Expose it globally so every page script (auth.js, dashboard.js, etc.)
// can just use `sb` directly without re-importing.
window.sb = sb;
