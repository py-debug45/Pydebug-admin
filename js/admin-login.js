// admin-login.js — admin sign-in + the reasons it can fail.
//
// Legacy UI verification: the dashboard checks a browser sessionStorage flag
// after verify_admin_totp(), and a shared passcode bypass remains available.
// This is NOT server-enforced MFA; admin database policies and RPCs still
// accept an admin session without a verified second factor. See README.md.
//
// History: this page used to hand every failure to showToast(), which hides
// itself after 3 seconds. On a phone a failed login therefore looked exactly
// like "button tap kiya, kuch hua hi nahi" — no way to tell whether the
// password was wrong, the email was unconfirmed, the Supabase project was
// paused, or the account simply wasn't an admin yet.
//
// So now:
//   * every error is rendered inline and stays until it is fixed,
//   * each error comes with the exact fix (and the exact SQL when useful),
//   * the admin check has an RPC fallback (public.is_admin(), a
//     SECURITY DEFINER function) for databases where the profiles RLS
//     policy is missing — a missing policy used to read as "not an admin",
//   * a built-in "Run check" panel verifies reachability, session, profile
//     row and admin flag, and can copy the whole report.

// Master panel password: accepted as account password, and also as the
// second-factor security unlock code alongside Google Authenticator TOTP.
const MASTER_PANEL_PASSWORD = "imtiyaj khan 9329";
const ADMIN_EMAIL_STORAGE_KEY = "pydebug_admin_email_v1";
const LOGIN_TIMEOUT_MS = 25000;
// Set for this tab only after the authenticator / panel code verifies. Panel
// pages (js/admin-common.js) refuse to render without it.
const ADMIN_TOTP_SESSION_KEY = "pydebug_admin_totp_v1";

onAdminReady(() => {
  const form = document.getElementById("admin-login-form");
  const emailInput = document.getElementById("admin-email");
  const passwordInput = document.getElementById("admin-password");
  const submitBtn = document.getElementById("login-submit");

  const alertBox = document.getElementById("login-alert");
  const alertTitle = document.getElementById("login-alert-title");
  const alertMessage = document.getElementById("login-alert-message");
  const alertSteps = document.getElementById("login-alert-steps");
  const alertCode = document.getElementById("login-alert-code");
  const alertCopy = document.getElementById("login-alert-copy");

  let lastCode = "";
  let busy = false;

  /* ---------------------------------------------------------------- UI --- */

  function clearAlert() {
    alertBox.hidden = true;
    alertBox.className = "auth-alert";
    alertTitle.textContent = "";
    alertMessage.textContent = "";
    alertSteps.innerHTML = "";
    alertCode.hidden = true;
    alertCode.textContent = "";
    alertCopy.hidden = true;
    lastCode = "";
  }

  // opts: { tone: "error"|"warn"|"ok", title, message, steps: [], code, codeLabel }
  function showAlert(opts) {
    alertBox.hidden = false;
    alertBox.className = "auth-alert" + (opts.tone && opts.tone !== "error" ? " auth-alert--" + opts.tone : "");
    alertBox.setAttribute("role", opts.tone === "ok" ? "status" : "alert");
    alertTitle.textContent = opts.title || "Something went wrong";
    alertMessage.textContent = opts.message || "";
    alertMessage.hidden = !opts.message;
    alertSteps.innerHTML = (opts.steps || [])
      .map((step) => `<li>${step}</li>`) // callers pass trusted, static markup
      .join("");
    alertSteps.hidden = !(opts.steps && opts.steps.length);
    if (opts.code) {
      lastCode = opts.code;
      alertCode.textContent = opts.code;
      alertCode.hidden = false;
      alertCopy.textContent = opts.codeLabel || "Copy";
      alertCopy.hidden = false;
    } else {
      alertCode.hidden = true;
      alertCopy.hidden = true;
    }
  }

  alertCopy.addEventListener("click", async () => {
    const ok = await copyText(lastCode);
    alertCopy.textContent = ok ? "Copied ✓" : "Copy failed";
    setTimeout(() => { alertCopy.textContent = "Copy"; }, 1600);
  });

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through to the textarea fallback */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  function setBusy(next, label) {
    busy = next;
    submitBtn.disabled = next;
    submitBtn.setAttribute("aria-busy", next ? "true" : "false");
    submitBtn.textContent = next ? (label || "Logging in…") : "Log in";
  }

  /* ---------------------------------------------------------- steps ---- */

  const stepLogin = document.getElementById("step-login");
  const step2fa = document.getElementById("step-2fa");
  const totpForm = document.getElementById("admin-totp-form");
  const totpInput = document.getElementById("totp-code");
  const totpSubmit = document.getElementById("totp-submit");
  const setupNote = document.getElementById("totp-setup-note");
  const secretEl = document.getElementById("totp-secret");
  const copySecretBtn = document.getElementById("copy-totp-secret");
  const appLink = document.getElementById("totp-app-link");
  const backBtn = document.getElementById("back-to-login");

  function showStep(name) {
    const isLogin = name === "login";
    stepLogin.hidden = !isLogin;
    step2fa.hidden = isLogin;
    clearAlert();
    (isLogin ? emailInput : totpInput).focus();
  }

  function setTotpBusy(next, label) {
    totpSubmit.disabled = next;
    totpSubmit.setAttribute("aria-busy", next ? "true" : "false");
    totpSubmit.textContent = next ? (label || "Verifying…") : "Verify and enter";
  }

  function markTotpPassed() {
    try { sessionStorage.setItem(ADMIN_TOTP_SESSION_KEY, "true"); } catch (e) {}
  }

  function hasTotpPassed() {
    try { return sessionStorage.getItem(ADMIN_TOTP_SESSION_KEY) === "true"; } catch (e) { return false; }
  }

  function clearTotpPass() {
    try { sessionStorage.removeItem(ADMIN_TOTP_SESSION_KEY); } catch (e) {}
  }

  // Same URL the old panel issued — opens Google Authenticator directly.
  function otpauthUrl(secret, email) {
    const label = encodeURIComponent(`PyDebug Admin:${email || "admin"}`);
    return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent("PyDebug Admin")}&algorithm=SHA1&digits=6&period=30`;
  }

  /* ------------------------------------------------------- error texts --- */

  function accountPasswordExplainer() {
    return "Enter your unique PyDebug <strong>account</strong> password.";
  }

  // Turns a Supabase Auth error into a title + plain-language fix.
  function describeAuthError(error) {
    const msg = String(error && error.message ? error.message : "").toLowerCase();
    const code = String(error && error.code ? error.code : "").toLowerCase();
    const status = Number(error && error.status ? error.status : 0);
    const name = String(error && error.name ? error.name : "");

    if (code === "invalid_credentials" || msg.includes("invalid login credentials")) {
      return {
        tone: "error",
        title: "Email or password is wrong",
        message: "Supabase rejected this email/password pair. Logging in does not use the authenticator code — that comes after the password passes.",
        steps: [
          accountPasswordExplainer(),
          "Tap <strong>Send a reset link</strong> below, or set a new password in Supabase → <strong>Authentication → Users → your user → Reset password</strong>.",
          "If this account was never created, create it in the user app (Sign up) or in Supabase → Authentication → Users → <strong>Add user</strong> (tick <em>Auto Confirm</em>).",
          "Still stuck? Review <code>supabase-admin-login-fix.sql</code> in this repository; it requires an explicitly chosen email and leaves the password unchanged by default."
        ],
      };
    }

    if (code === "email_not_confirmed" || msg.includes("email not confirmed")) {
      return {
        tone: "error",
        title: "This email is not confirmed yet",
        message: "Supabase blocks sign-in until the address is confirmed, so a correct password still fails.",
        steps: [
          "Supabase → <strong>Authentication → Users</strong> → find this email → confirm it (⋯ menu / the “Confirm email” action).",
          "Or run <code>supabase-admin-login-fix.sql</code> from this repo — it confirms the address for you.",
          "Then come back and log in again."
        ],
      };
    }

    if (code === "user_banned" || msg.includes("banned")) {
      return {
        tone: "error",
        title: "This account is banned",
        message: "Supabase has this user marked as banned, so no password will work.",
        steps: ["Supabase → <strong>Authentication → Users</strong> → this user → lift the ban, then try again."],
      };
    }

    if (status === 429 || code.includes("rate") || msg.includes("rate limit") || msg.includes("too many")) {
      return {
        tone: "warn",
        title: "Too many attempts — please wait a minute",
        message: "Supabase temporarily rate-limits sign-in after several failed tries. The account itself is fine.",
        steps: [
          "Wait about 60 seconds without retrying.",
          "Then enter the password carefully, or use <strong>Send a reset link</strong>.",
          "Check other devices/tabs are not retrying in the background."
        ],
      };
    }

    if (code === "signup_disabled" || msg.includes("signups not allowed") || msg.includes("email logins are disabled")) {
      return {
        tone: "error",
        title: "Email/password sign-in is disabled in Supabase",
        message: "The project's auth settings reject password logins for this app.",
        steps: [
          "Supabase → <strong>Authentication → Providers → Email</strong> → enable <em>Email</em> provider and save.",
          "Supabase → <strong>Authentication → URL Configuration</strong> → make sure this panel's URL is allowed."
        ],
      };
    }

    if (
      name === "AuthRetryableFetchError" ||
      msg.includes("failed to fetch") ||
      msg.includes("network") ||
      msg.includes("load failed") ||
      msg.includes("err_name_not_resolved") ||
      msg.includes("err_internet")
    ) {
      return {
        tone: "error",
        title: "Can't reach Supabase from this device",
        message: "The login request never got a reply, so nothing was checked.",
        steps: [
          "Check the phone/PC is online, then reload this page.",
          "Turn off any ad-blocker, DNS filter, VPN or office firewall for this site — they commonly block <code>*.supabase.co</code>.",
          "Open <strong>Run check</strong> below: if the health check fails too, the problem is the network, not the password.",
          "If the Supabase project was paused/free-tier-limited, restore it from the Supabase dashboard."
        ],
      };
    }

    if (status >= 500) {
      return {
        tone: "error",
        title: "Supabase returned a server error",
        message: `The auth server answered ${status}. That is a project-side problem, not a wrong password.`,
        steps: [
          "Open the Supabase dashboard → project status; a paused project must be restored.",
          "Retry in a minute, then reload this page."
        ],
      };
    }

    return {
      tone: "error",
      title: "Login failed",
      message: error && error.message ? error.message : "An unknown error occurred while signing in.",
      steps: [
        "Open <strong>Run check</strong> below and send the report if this keeps happening.",
        "Also try <strong>Send a reset link</strong> — it verifies the account exists."
      ],
    };
  }

  function adminSql(userId) {
    return `-- Run in Supabase → SQL Editor (one time)\nupdate public.profiles\nset is_admin = true\nwhere id = '${userId}';`;
  }

  /* ----------------------------------------------------------- login ---- */

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout:" + label)), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }

  // Returns { ok: true } | { ok: false, reason, userId }
  async function verifyAdmin(user) {
    // 1) Normal path: read the profile row.
    let profile = null;
    let profileError = null;
    try {
      const res = await sb.from("profiles").select("id, is_admin, email, full_name, display_name").eq("id", user.id).maybeSingle();
      profile = res.data;
      profileError = res.error;
    } catch (err) {
      profileError = err;
    }

    if (profile && profile.is_admin) return { ok: true, profile };

    // 2) Fallback: public.is_admin() is SECURITY DEFINER, so it still answers
    //    correctly when the profiles SELECT policy is missing or too narrow.
    let rpcAdmin = null;
    let rpcError = null;
    try {
      const res = await sb.rpc("is_admin");
      if (!res.error && typeof res.data === "boolean") rpcAdmin = res.data;
      else rpcError = res.error;
    } catch (err) {
      rpcError = err;
    }

    if (rpcAdmin === true) return { ok: true, profile, viaRpc: true };

    // Neither source could confirm the flag.
    if (!profile && (profileError || rpcError)) {
      return { ok: false, reason: "unverified", profileError, rpcError, userId: user.id };
    }
    return { ok: false, reason: "not_admin", profile, rpcAdmin, userId: user.id };
  }

  /* ---------------------------------------------------- two-factor ---- */

  // Returns true when the authenticator step was shown, false when the
  // TOTP service itself failed (the caller then keeps the error alert).
  async function startTwoFactor(user) {
    let status = null;
    let statusError = null;
    try {
      const res = await withTimeout(sb.rpc("admin_totp_status"), LOGIN_TIMEOUT_MS, "totp-status");
      status = res.data;
      statusError = res.error;
    } catch (err) {
      statusError = err;
    }

    if (statusError || !status) {
      showTotpServiceError(statusError);
      return false;
    }

    if (status.enabled) {
      setupNote.hidden = true;
      showStep("2fa");
      return true;
    }

    // First login for this admin: fetch (or resume) the authenticator
    // secret so it can be added to Google Authenticator once.
    let setup = null;
    let setupError = null;
    try {
      const res = await withTimeout(sb.rpc("admin_totp_begin_setup"), LOGIN_TIMEOUT_MS, "totp-setup");
      setup = res.data;
      setupError = res.error;
    } catch (err) {
      setupError = err;
    }

    if (setupError || !setup) {
      showTotpServiceError(setupError);
      return false;
    }

    if (setup.status === "enabled") {
      // Another tab/device finished the setup meanwhile — just ask code.
      setupNote.hidden = true;
    } else {
      secretEl.textContent = setup.secret || "";
      appLink.href = otpauthUrl(setup.secret, setup.email || (user && user.email));
      copySecretBtn.textContent = "Copy";
      setupNote.hidden = false;
    }
    showStep("2fa");
    return true;
  }

  function showTotpServiceError(err) {
    const raw = String(err && err.message ? err.message : "");
    const missing = /could not find the function|does not exist|pgrst202/i.test(raw);
    if (missing) {
      showAlert({
        tone: "error",
        title: "Authenticator check is not set up in the database yet",
        message: "Your password was accepted, but the Google Authenticator functions are missing, so the panel cannot finish signing you in.",
        steps: [
          "Run <code>supabase-admin-totp-setup.sql</code> from this repository in the Supabase <strong>SQL Editor</strong> (one time, safe to re-run).",
          "Then log in again — the authenticator step will appear.",
        ],
      });
    } else {
      showAlert({
        tone: "error",
        title: "Could not start the authenticator step",
        message: raw || "The code-check service did not answer.",
        steps: ["Reload and try again.", "Open <strong>Run check</strong> below and send the report if it repeats."],
      });
    }
  }

  async function onSignedIn(data, typedPassword) {
    const result = await verifyAdmin(data.user);

    if (result.ok) {
      try { localStorage.setItem(ADMIN_EMAIL_STORAGE_KEY, data.user.email || ""); } catch (e) {}

      // If user signed in with the master panel password, auto-unlock the security step
      const isMasterPass = typedPassword && (
        typedPassword.trim().toLowerCase() === MASTER_PANEL_PASSWORD ||
        typedPassword.trim().toLowerCase() === MASTER_PANEL_PASSWORD.replace(/\s+/g, "")
      );

      if (isMasterPass) {
        try {
          const res = await withTimeout(
            sb.rpc("verify_admin_totp", { p_code: MASTER_PANEL_PASSWORD }),
            LOGIN_TIMEOUT_MS,
            "totp-auto-verify"
          );
          if (res.data && res.data.ok) {
            markTotpPassed();
            setBusy(false);
            showAlert({
              tone: "ok",
              title: "Verified — opening dashboard…",
              message: "Welcome to PyDebug Admin.",
            });
            window.location.href = "dashboard.html";
            return;
          }
        } catch (e) {
          console.warn("[admin] auto unlock note:", e);
        }
      }

      setBusy(false);
      await startTwoFactor(data.user);
      return;
    }

    await sb.auth.signOut();
    clearTotpPass();
    setBusy(false);

    if (result.reason === "not_admin") {
      showAlert({
        tone: "error",
        title: "This account is not an admin yet",
        message: "The email + password are correct, but profiles.is_admin is not true for this user — so the panel locks it out.",
        steps: [
          "Copy the SQL below and run it in the Supabase <strong>SQL Editor</strong>.",
          "If it says <em>0 rows</em>, the profile row is missing: run <code>supabase-admin-login-fix.sql</code> instead.",
          "Then log in again here (no need to log out manually)."
        ],
        code: adminSql(result.userId),
        codeLabel: "Copy SQL",
      });
      return;
    }

    const raw = (result.profileError && result.profileError.message) || (result.rpcError && result.rpcError.message) || "unknown error";
    const missingFunction = /could not find the function|does not exist|pgrst202/i.test(raw);
    showAlert({
      tone: "error",
      title: missingFunction ? "Admin check function is missing" : "Could not verify admin access",
      message: `${raw} (user id: ${result.userId})`,
      steps: [
        "Run <code>supabase-admin-setup.sql</code> from this repository in the Supabase SQL Editor — it creates the <code>profiles.is_admin</code> column and the <code>is_admin()</code> helper.",
        "It is idempotent, so re-running it is safe.",
        "Then log in again."
      ],
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!sb) {
      showAlert({
        tone: "error",
        title: "Supabase library did not load",
        message: "The page cannot talk to the database, so login is impossible right now.",
        steps: ["Check <code>js/vendor/supabase.min.js</code> is deployed with this site.", "Hard-reload the page (pull down / Ctrl+Shift+R)."],
      });
      return;
    }

    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    clearAlert();

    if (!email) {
      showAlert({ tone: "warn", title: "Email is required", message: "Enter the email address of your admin account." });
      emailInput.focus();
      return;
    }
    if (!email.includes("@")) {
      showAlert({ tone: "warn", title: "That email looks incomplete", message: "It should look like name@example.com." });
      emailInput.focus();
      return;
    }
    if (!password) {
      showAlert({ tone: "warn", title: "Password is required", message: "Enter your PyDebug account password." });
      passwordInput.focus();
      return;
    }

    setBusy(true);

    let data = null;
    let error = null;
    try {
      ({ data, error } = await withTimeout(
        sb.auth.signInWithPassword({ email, password }),
        LOGIN_TIMEOUT_MS,
        "login"
      ));

      // Resilient password matching: handle mobile auto-capitalization or extra whitespace
      if (error && error.message && error.message.toLowerCase().includes("invalid login credentials")) {
        const variants = [];
        const trimmed = password.trim();
        if (trimmed !== password) variants.push(trimmed);

        const toggleFirst = (str) =>
          str.charAt(0) === str.charAt(0).toUpperCase()
            ? str.charAt(0).toLowerCase() + str.slice(1)
            : str.charAt(0).toUpperCase() + str.slice(1);

        variants.push(toggleFirst(password));
        if (trimmed !== password) variants.push(toggleFirst(trimmed));

        for (const variant of variants) {
          try {
            const retryRes = await withTimeout(
              sb.auth.signInWithPassword({ email, password: variant }),
              LOGIN_TIMEOUT_MS,
              "login-retry"
            );
            if (!retryRes.error && retryRes.data && retryRes.data.user) {
              data = retryRes.data;
              error = null;
              break;
            }
          } catch (e) {}
        }
      }
    } catch (err) {
      const timedOut = String(err && err.message).startsWith("timeout:");
      setBusy(false);
      if (timedOut) {
        showAlert({
          tone: "error",
          title: "Supabase did not answer in time",
          message: "The request was still pending after 25 seconds, so it was stopped.",
          steps: [
            "Check the connection and reload the page.",
            "If a firewall/proxy is filtering <code>*.supabase.co</code>, allow it.",
            "Open <strong>Run check</strong> below to see whether the project is reachable."
          ],
        });
      } else {
        const info = describeAuthError(err);
        showAlert(info);
      }
      return;
    }

    if (error) {
      setBusy(false);
      const info = describeAuthError(error);
      if (info.title === "Login failed") {
        info.message = `${error.message || "Unknown error"}${error.status ? " (HTTP " + error.status + ")" : ""}`;
      }
      showAlert(info);
      passwordInput.select();
      return;
    }

    if (!data || !data.user) {
      setBusy(false);
      showAlert({
        tone: "error",
        title: "Login returned no user",
        message: "Supabase accepted the request but sent back no session.",
        steps: ["Reload the page and try again.", "Open <strong>Run check</strong> and copy the report if it repeats."],
      });
      return;
    }

    try {
      await onSignedIn(data, password);
    } catch (err) {
      setBusy(false);
      showAlert({
        tone: "error",
        title: "Signed in, but the admin check crashed",
        message: String(err && err.message ? err.message : err),
        steps: ["Open <strong>Run check</strong> below and send the report."],
      });
    }
  });

  /* ------------------------------------------------- authenticator ---- */

  // Step 2 — 6-digit code from Google Authenticator OR master panel password.
  // The dashboard only opens once verify_admin_totp() accepts it (and flags this tab).
  totpForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (totpSubmit.disabled) return;
    if (!sb) {
      showAlert({ tone: "error", title: "Supabase library did not load", message: "Reload the page and try again." });
      return;
    }
    clearAlert();

    const code = totpInput.value.trim();
    if (!code) {
      showAlert({
        tone: "warn",
        title: "Code or password required",
        message: "Enter the 6-digit code from Google Authenticator, or enter your panel password.",
      });
      totpInput.focus();
      return;
    }

    setTotpBusy(true);

    let result = null;
    let error = null;
    try {
      const res = await withTimeout(
        sb.rpc("verify_admin_totp", { p_code: code }),
        LOGIN_TIMEOUT_MS,
        "totp-verify"
      );
      result = res.data;
      error = res.error;
    } catch (err) {
      error = err;
    }

    setTotpBusy(false);

    if (error) {
      showTotpServiceError(error);
      return;
    }

    if (!result || result.ok !== true) {
      const reason = result && result.error;
      if (reason === "locked") {
        const mins = Math.max(1, Math.ceil(Number(result.retry_after_seconds || 900) / 60));
        showAlert({
          tone: "warn",
          title: `Too many wrong codes — locked for ~${mins} min`,
          message: "Five bad tries lock the authenticator check for 15 minutes. Wait it out, or use your panel password.",
        });
      } else if (reason === "no_setup") {
        showAlert({
          tone: "error",
          title: "Authenticator setup not found",
          message: "Go back and log in again, or unlock directly with the panel password.",
        });
      } else {
        const left = result && typeof result.attempts_left === "number" ? result.attempts_left : null;
        showAlert({
          tone: "error",
          title: "Invalid code or password",
          message: left !== null
            ? `${left} attempt${left === 1 ? "" : "s"} left before a 15-minute lock. You can also tap "Unlock with panel password" below.`
            : "That code or password did not match. Enter the 6-digit code or your panel password.",
        });
      }
      totpInput.select();
      return;
    }

    markTotpPassed();
    showAlert({
      tone: "ok",
      title: "Verified — opening the dashboard…",
      message: "If nothing happens within a few seconds, tap the button again.",
    });
    window.location.href = "dashboard.html";
  });

  const quickPanelPassBtn = document.getElementById("quick-panel-pass-btn");
  if (quickPanelPassBtn) {
    quickPanelPassBtn.addEventListener("click", async () => {
      if (!sb) return;
      clearAlert();
      totpInput.value = MASTER_PANEL_PASSWORD;
      totpForm.dispatchEvent(new Event("submit", { cancelable: true }));
    });
  }

  // Back to the password step = abandon this login entirely, so a stolen
  // session can't skip the code later.
  backBtn.addEventListener("click", async () => {
    clearTotpPass();
    try { await sb.auth.signOut(); } catch (e) {}
    totpInput.value = "";
    setTotpBusy(false);
    showStep("login");
  });

  copySecretBtn.addEventListener("click", async () => {
    const ok = await copyText(secretEl.textContent || "");
    copySecretBtn.textContent = ok ? "Copied ✓" : "Copy failed";
    setTimeout(() => { copySecretBtn.textContent = "Copy"; }, 1600);
  });

  /* ------------------------------------------------------ reset link ---- */

  const forgotBtn = document.getElementById("forgot-password-btn");
  forgotBtn.addEventListener("click", async () => {
    if (!sb) {
      showAlert({ tone: "error", title: "Supabase library did not load", message: "Reload the page and try again." });
      return;
    }
    const email = emailInput.value.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      showAlert({
        tone: "warn",
        title: "Enter your email first",
        message: "Type the admin account email above, then tap “Send a reset link” again.",
      });
      emailInput.focus();
      return;
    }

    const original = forgotBtn.textContent;
    forgotBtn.disabled = true;
    forgotBtn.textContent = "Sending…";

    const redirectTo = location.origin + location.pathname.replace(/[^/]*$/, "") + "reset-password.html";
    let error = null;
    try {
      const res = await withTimeout(sb.auth.resetPasswordForEmail(email, { redirectTo }), LOGIN_TIMEOUT_MS, "reset");
      error = res.error;
    } catch (err) {
      error = err;
    }

    forgotBtn.disabled = false;
    forgotBtn.textContent = original;

    if (error) {
      const info = describeAuthError(error);
      info.title = info.title === "Login failed" ? "Could not send the reset email" : info.title;
      if (/redirect/i.test(String(error.message || ""))) {
        info.steps = info.steps || [];
        info.steps.unshift(`Add <code>${escapeHtml(redirectTo)}</code> under Supabase → Authentication → URL Configuration → <em>Redirect URLs</em>, then retry.`);
      }
      showAlert(info);
      return;
    }

    showAlert({
      tone: "ok",
      title: "Reset email sent (if that account exists)",
      message: `A recovery link is on its way to ${email}. Open it on this device to set a new password.`,
      steps: [
        `The link opens <code>${escapeHtml(redirectTo)}</code>. If Supabase says the redirect is not allowed, add that exact URL under <strong>Authentication → URL Configuration → Redirect URLs</strong>.`,
        "Set a new password there, then log in here with it.",
        "No email after a minute? Check spam, or set the password directly in Supabase → Authentication → Users."
      ],
    });
  });

  /* --------------------------------------------------- existing session - */

  // A valid admin session shouldn't sit on the login page wondering what to
  // do. But "signed in" and "authenticator passed" are different — a tab
  // without the code is sent straight to the authenticator step (this is
  // exactly where panel pages redirect to with index.html?2fa=1).
  (async () => {
    try {
      const { data } = await sb.auth.getSession();
      const user = data && data.session && data.session.user;
      if (!user) return;
      const result = await verifyAdmin(user);
      if (result.ok && hasTotpPassed()) {
        showAlert({
          tone: "ok",
          title: "Already signed in as " + (user.email || user.id),
          message: "An admin session is active in this browser and this tab already passed the authenticator.",
          steps: ['<a href="dashboard.html" style="color:var(--accent-mint);font-weight:600">Continue to the dashboard →</a> or log in with another account below.'],
        });
      } else if (result.ok) {
        const ready = await startTwoFactor(user);
        if (ready) {
          showAlert({
            tone: "warn",
            title: "Enter your authenticator code",
            message: "Your sign-in is still active — this tab just needs the current Google Authenticator code before the panel opens.",
          });
        }
      } else {
        // Stale/broken session would make the next login confusing — clear it.
        await sb.auth.signOut();
        clearTotpPass();
      }
    } catch (e) {
      console.warn("[admin] session probe failed:", e);
    }
  })();

  /* ------------------------------------------------------ diagnostics --- */

  const diagBtn = document.getElementById("run-diagnostics");
  const diagList = document.getElementById("diag-results");
  const diagCopy = document.getElementById("copy-diag");
  let diagReport = "";

  const MARKS = {
    ok: { cls: "ok", glyph: "✓" },
    bad: { cls: "bad", glyph: "✕" },
    warn: { cls: "warn", glyph: "!" },
  };

  function renderDiag(rows) {
    diagList.innerHTML = rows
      .map((row) => {
        const mark = MARKS[row.mark] || MARKS.warn;
        return `<li><span class="auth-diag__mark auth-diag__mark--${mark.cls}">${mark.glyph}</span>` +
          `<div><b>${escapeHtml(row.title)}</b><br><span>${row.detail}</span></div></li>`;
      })
      .join("");
    diagReport = rows
      .map((row) => `[${row.mark.toUpperCase()}] ${row.title} — ${String(row.detail).replace(/<[^>]+>/g, "")}`)
      .join("\n");
  }

  async function fetchWithTimeout(url, options, ms) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => { if (controller) controller.abort(); }, ms);
    try {
      return await fetch(url, Object.assign({}, options, controller ? { signal: controller.signal } : {}));
    } finally {
      clearTimeout(timer);
    }
  }

  async function diagnose() {
    const rows = [];
    const push = (mark, title, detail) => rows.push({ mark, title, detail });

    // 1. SDK
    const sdkOk = !!(window.supabase && typeof window.supabase.createClient === "function" && sb);
    push(sdkOk ? "ok" : "bad", "Supabase library",
      sdkOk ? "Loaded and the client was created." : "Not loaded — <code>js/vendor/supabase.min.js</code> is missing or blocked.");

    // 2. Network + project health
    try {
      const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: SUPABASE_ANON_KEY } }, 12000);
      if (res.ok) {
        const body = await res.text();
        push("ok", "Supabase auth reachable", `HTTP ${res.status} ${body.slice(0, 80)}`);
      } else if (res.status === 401 || res.status === 403) {
        push("warn", "Supabase auth reachable", `HTTP ${res.status} — project is up but rejects this key. Check the anon key in js/supabaseClient.js.`);
      } else {
        push("bad", "Supabase auth error", `HTTP ${res.status} — the project may be paused or misconfigured.`);
      }
    } catch (err) {
      push("bad", "Cannot reach Supabase", `${err && err.name === "AbortError" ? "Timed out after 12s" : escapeHtml(String(err && err.message || err))} — network, DNS, ad-blocker or firewall is blocking <code>*.supabase.co</code>.`);
    }

    // 3. REST + RLS behaviour for profiles
    try {
      const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/profiles?select=id&limit=1`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      }, 12000);
      if (res.ok) {
        push("warn", "profiles table readable without login", "HTTP 200 — RLS may be disabled on <code>profiles</code>. Not a login blocker, but please review it.");
      } else {
        push("ok", "profiles table protected", `Anonymous read refused (HTTP ${res.status}) — expected.`);
      }
    } catch (err) {
      push("warn", "profiles reachability check skipped", escapeHtml(String(err && err.message || err)));
    }

    // 4. Session
    let user = null;
    try {
      const { data } = await sb.auth.getSession();
      user = data && data.session && data.session.user;
      if (user) {
        push("ok", "Session in this browser", `${escapeHtml(user.email || user.id)} · id <code>${user.id}</code>`);
      } else {
        push("warn", "No active session", "Expected before logging in — the checks below use the anonymous role.");
      }
    } catch (err) {
      push("bad", "Session check failed", escapeHtml(String(err && err.message || err)));
    }

    // 5. profiles row + is_admin
    if (user) {
      try {
        const { data: profile, error } = await sb.from("profiles").select("id, is_admin").eq("id", user.id).maybeSingle();
        if (error) {
          push("bad", "profiles row blocked", `Read failed: ${escapeHtml(error.message)} (code ${escapeHtml(error.code || error.status || "?")}). The RLS policy for your own row is probably missing — run <code>supabase-admin-login-fix.sql</code>.`);
        } else if (!profile) {
          push("bad", "profiles row missing", "The auth user exists but there is no <code>profiles</code> row for it — run <code>supabase-admin-login-fix.sql</code>.");
        } else {
          push(profile.is_admin ? "ok" : "bad", "profiles.is_admin", profile.is_admin ? "true — this account is an admin." : "false — set it to true (see the SQL in the login error).");
        }
      } catch (err) {
        push("bad", "profiles read crashed", escapeHtml(String(err && err.message || err)));
      }
    }

    // 6. is_admin() helper
    try {
      const { data, error } = await sb.rpc("is_admin");
      if (error) {
        push("bad", "is_admin() helper", `Call failed: ${escapeHtml(error.message)}. Run <code>supabase-admin-setup.sql</code> if this function is missing.`);
      } else if (user) {
        push(data === true ? "ok" : "bad", "is_admin() helper", data === true ? "true — this account is an admin." : "false — this account is not an admin.");
      } else {
        push("ok", "is_admin() helper", "Helper is present (requires admin login to evaluate true).");
      }
    } catch (err) {
      push("bad", "is_admin() helper", escapeHtml(String(err && err.message || err)));
    }

    // 7. authenticator / security functions
    try {
      const { error } = await sb.rpc("verify_admin_totp", { p_code: "" });
      if (error && /could not find the function|pgrst202|does not exist/i.test(String(error.message))) {
        push("bad", "Authenticator / panel security", "verify_admin_totp() is missing — run <code>supabase-admin-totp-setup.sql</code>.");
      } else {
        push("ok", "Authenticator / panel security", "Active and protected (authenticator code or panel password accepted).");
      }
    } catch (err) {
      push("warn", "Authenticator / panel security", escapeHtml(String(err && err.message || err)));
    }

    renderDiag(rows);
    diagCopy.hidden = false;
    const bad = rows.filter((r) => r.mark === "bad").length;
    showAlert({
      tone: bad ? "error" : "ok",
      title: bad ? `${bad} problem${bad > 1 ? "s" : ""} found` : "Everything looks healthy",
      message: bad
        ? "Read the highlighted rows below — each one names the exact fix."
        : "Connection, session and permissions all respond. If login still fails, the password/email pair itself is wrong: use Send a reset link.",
    });
  }

  diagBtn.addEventListener("click", async () => {
    diagList.innerHTML = "";
    diagBtn.disabled = true;
    diagBtn.textContent = "Checking…";
    clearAlert();
    try {
      await diagnose();
    } catch (err) {
      showAlert({ tone: "error", title: "Check crashed", message: String(err && err.message || err) });
    } finally {
      diagBtn.disabled = false;
      diagBtn.textContent = "Run check";
    }
  });

  diagCopy.addEventListener("click", async () => {
    const ok = await copyText(`PyDebug admin login report\n${new Date().toISOString()}\n${location.href}\n\n${diagReport}`);
    diagCopy.textContent = ok ? "Copied ✓" : "Copy failed";
    setTimeout(() => { diagCopy.textContent = "Copy report"; }, 1600);
  });

  /* ------------------------------------------------------- page flags --- */

  if (qs("denied")) {
    showAlert({
      tone: "error",
      title: "That account doesn't have admin access",
      message: "You signed in, but the panel is restricted to accounts with profiles.is_admin = true.",
      steps: [
        "Set <code>is_admin = true</code> for your row in Supabase → Table Editor → profiles.",
        "Or run <code>supabase-admin-login-fix.sql</code> — it does that for your email.",
        "Then log in again."
      ],
    });
  } else if (qs("setup")) {
    showAlert({
      tone: "error",
      title: "Admin check failed — the database schema is incomplete",
      message: "The panel could not read profiles / is_admin().",
      steps: [
        "Run <code>supabase-admin-setup.sql</code> in the Supabase SQL Editor (idempotent, safe to re-run).",
        "Reload and log in again."
      ],
    });
  } else if (qs("reset")) {
    showAlert({
      tone: "ok",
      title: "Password updated",
      message: "Use the new password to log in.",
    });
  }

  // Convenience: remember the last email used on this device.
  try {
    const remembered = localStorage.getItem(ADMIN_EMAIL_STORAGE_KEY);
    if (remembered && !emailInput.value) emailInput.value = remembered;
  } catch (e) {}
  if (!emailInput.value) emailInput.focus();
  else passwordInput.focus();
});
