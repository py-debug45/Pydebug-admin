// admin-login.js

document.addEventListener("DOMContentLoaded", () => {
  if (qs("denied")) {
    showToast("That account doesn't have admin access.", "error");
  }
  if (qs("setup")) {
    showToast("Admin check failed — is the Supabase schema/RLS set up? See README step 1.", "error");
  }

  const form = document.getElementById("admin-login-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("admin-email").value.trim();
    const password = document.getElementById("admin-password").value;
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Logging in...";

    const { data, error } = await sb.auth.signInWithPassword({ email, password });

    if (error) {
      showToast(error.message, "error");
      btn.disabled = false;
      btn.textContent = "Log in";
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
      await sb.auth.signOut();
      showToast("Admin check failed — verify the Supabase schema/RLS setup (README step 1).", "error");
      btn.disabled = false;
      btn.textContent = "Log in";
      return;
    }

    if (!profile || !profile.is_admin) {
      await sb.auth.signOut();
      showToast("This account doesn't have admin access.", "error");
      btn.disabled = false;
      btn.textContent = "Log in";
      return;
    }

    window.location.href = "dashboard.html";
  });
});
