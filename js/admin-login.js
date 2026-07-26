// admin-login.js

document.addEventListener("DOMContentLoaded", () => {
  if (qs("denied")) {
    showToast("That account doesn't have admin access.", "error");
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

    const { data: profile } = await sb
      .from("profiles")
      .select("is_admin")
      .eq("id", data.user.id)
      .single();

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
