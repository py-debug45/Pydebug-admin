// admin-login.js

document.addEventListener("DOMContentLoaded", async () => {
  const messages = {
    denied: ["That account doesn't have admin access.", "error"],
    setup: ["Admin check failed — is the Supabase schema/RLS set up? See README step 1.", "error"],
    offline: ["Couldn't reach Supabase. Check your connection and try again.", "error"],
  };

  let shown = false;
  Object.keys(messages).forEach((key) => {
    if (qs(key)) {
      const [text, type] = messages[key];
      showToast(text, type);
      shown = true;
    }
  });

  // Strip the one-shot query flags so a refresh (or a bookmark) doesn't keep
  // re-showing "you're not an admin" forever.
  if (shown && window.history.replaceState) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const form = document.getElementById("admin-login-form");
  if (!form) return;

  const btn = form.querySelector("button[type=submit]");
  const setBusy = (busy, label) => {
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = label;
  };

  // Already signed in as an admin? Skip the form. (Previously a returning
  // admin with a live session was shown the login page again and had to
  // re-enter credentials for no reason.)
  if (!shown) {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session) {
        const { data: profile } = await sb
          .from("profiles")
          .select("is_admin")
          .eq("id", session.user.id)
          .single();
        if (profile && profile.is_admin) {
          window.location.replace("dashboard.html");
          return;
        }
      }
    } catch (err) {
      console.error("admin-login: session pre-check failed:", err);
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (btn && btn.disabled) return; // ignore double submits

    const email = document.getElementById("admin-email").value.trim();
    const password = document.getElementById("admin-password").value;

    if (!email || !password) {
      showToast("Enter both your email and password.", "error");
      return;
    }

    setBusy(true, "Logging in...");

    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });

      if (error) {
        showToast(errorText(error), "error");
        setBusy(false, "Log in");
        return;
      }

      const { data: profile, error: profileError } = await sb
        .from("profiles")
        .select("is_admin")
        .eq("id", data.user.id)
        .single();

      // PGRST116 = no profiles row (user isn't an admin). Any other error means
      // the schema/RLS setup is broken — say so instead of "not an admin".
      if (profileError && profileError.code !== "PGRST116") {
        await signOutQuietlyLocal();
        showToast("Admin check failed — verify the Supabase schema/RLS setup (README step 1).", "error");
        setBusy(false, "Log in");
        return;
      }

      if (!profile || !profile.is_admin) {
        await signOutQuietlyLocal();
        showToast("This account doesn't have admin access.", "error");
        setBusy(false, "Log in");
        return;
      }

      window.location.href = "dashboard.html";
    } catch (err) {
      // A thrown fetch error used to leave the button stuck on "Logging in..."
      // with nothing on screen explaining why.
      console.error("admin-login: sign-in failed:", err);
      showToast("Login failed: " + errorText(err), "error");
      setBusy(false, "Log in");
    }
  });
});

// admin-common.js isn't loaded on the login page, so keep a local copy.
async function signOutQuietlyLocal() {
  try {
    await sb.auth.signOut();
  } catch (err) {
    console.error("signOut failed:", err);
  }
}

// errorText() also lives in admin-common.js (not loaded here).
function errorText(error) {
  if (!error) return "Unknown error";
  return error.message || error.error_description || error.details || String(error);
}
