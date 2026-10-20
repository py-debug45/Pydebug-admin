// admin-reset.js — the other half of "login doesn't work": if the account
// password is wrong or forgotten, Supabase's recovery email lands here.
//
// Why its own client: js/supabaseClient.js deliberately runs with
// detectSessionInUrl:false (the panel should never parse stray URL tokens on
// normal pages). The recovery link arrives as #access_token=…&type=recovery,
// so this page asks for one extra client with that option switched on.

onAdminReady(async () => {
  const form = document.getElementById("reset-form");
  const checking = document.getElementById("reset-checking");
  const newInput = document.getElementById("new-password");
  const confirmInput = document.getElementById("confirm-password");
  const submitBtn = document.getElementById("reset-submit");

  const alertBox = document.getElementById("reset-alert");
  const alertTitle = document.getElementById("reset-alert-title");
  const alertMessage = document.getElementById("reset-alert-message");
  const alertSteps = document.getElementById("reset-alert-steps");

  function showAlert(tone, title, message, steps) {
    alertBox.hidden = false;
    alertBox.className = "auth-alert" + (tone && tone !== "error" ? " auth-alert--" + tone : "");
    alertTitle.textContent = title;
    alertMessage.textContent = message || "";
    alertMessage.hidden = !message;
    alertSteps.innerHTML = (steps || []).map((s) => `<li>${s}</li>`).join("");
    alertSteps.hidden = !(steps && steps.length);
  }

  // Supabase reports a used/expired link as #error=… or ?error=…
  const params = new URLSearchParams(location.search);
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
  const linkError = params.get("error_description") || hashParams.get("error_description") ||
    params.get("error") || hashParams.get("error");

  const recovery = typeof createSupabaseClient === "function"
    ? createSupabaseClient({
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      })
    : null;

  if (!recovery) {
    checking.hidden = true;
    showAlert("error", "Supabase library did not load",
      "This page cannot reach the auth service, so the password cannot be changed here.",
      ["Check js/vendor/supabase.min.js is deployed.", "Hard-reload the page and try the link again."]);
    return;
  }

  let ready = false;
  function showForm() {
    if (ready) return;
    ready = true;
    checking.hidden = true;
    form.hidden = false;
    newInput.focus();
  }

  function showBrokenLink(reason) {
    if (ready) return;
    checking.hidden = true;
    form.hidden = true;
    showAlert("error", "This recovery link can't be used",
      reason || "The link is expired, already used, or was opened on a different device.",
      [
        "Go back to the login page and tap <strong>Send a reset link</strong> again.",
        "Open the newest email on this same device — links only work once.",
        "Or set the password directly in Supabase → Authentication → Users → your user → Reset password."
      ]);
  }

  if (linkError) {
    const expired = /expired|invalid|otp/i.test(linkError);
    showBrokenLink(expired ? "Supabase says this link is expired or already used." : linkError);
  }

  // Two signals, whichever arrives first: the PASSWORD_RECOVERY event, or an
  // already-restored session (the link may have been opened a moment ago).
  recovery.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session)) showForm();
  });

  try {
    const { data } = await recovery.auth.getSession();
    if (data && data.session) showForm();
  } catch (e) {
    console.warn("[admin] recovery session check failed:", e);
  }

  // Give the SDK a few seconds to parse the URL before calling the link dead.
  setTimeout(() => {
    if (!ready && !linkError) {
      showBrokenLink("No recovery session was found in this URL. The link may have expired, or it was already used once.");
    }
  }, 5000);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = newInput.value;
    const confirm = confirmInput.value;

    if (password.length < 6) {
      showAlert("warn", "Password is too short", "Supabase requires at least 6 characters.");
      newInput.focus();
      return;
    }
    if (password !== confirm) {
      showAlert("warn", "The two passwords don't match", "Retype the same password in both boxes.");
      confirmInput.focus();
      confirmInput.select();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    let error = null;
    try {
      const res = await recovery.auth.updateUser({ password });
      error = res.error;
    } catch (err) {
      error = err;
    }

    if (error) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save password";
      const msg = String(error.message || "");
      if (/session|jwt|not.*logged|missing/i.test(msg)) {
        showBrokenLink("The recovery session has expired. Request a new reset link.");
        return;
      }
      showAlert("error", "Could not save the password", msg,
        ["Use a longer password (8+ characters, letters + numbers).",
         "If Supabase complains the password is the same as the old one, pick a different one."]);
      return;
    }

    submitBtn.textContent = "Saved ✓";
    showAlert("ok", "Password updated",
      "You can log in with the new password now.",
      ['<a href="index.html?reset=1" style="color:var(--accent-mint);font-weight:600">Go to the login page →</a>']);
    // Clear the recovery session so the login page starts clean.
    try { await recovery.auth.signOut(); } catch (e) {}
    setTimeout(() => { window.location.href = "index.html?reset=1"; }, 1400);
  });
});
