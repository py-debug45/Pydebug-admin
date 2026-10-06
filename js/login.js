"use strict";

(() => {
  const $ = (selector) => document.querySelector(selector);
  let challenge = "";
  function error(message = "") { const target = $(".auth-step.is-active .auth-error"); if (target) target.textContent = message; }
  function step(name) { document.querySelectorAll(".auth-step").forEach((item) => item.classList.toggle("is-active", item.dataset.step === name)); error(""); }
  function busy(button, active) { button.disabled = active; button.dataset.label ||= button.textContent; button.textContent = active ? "Checking…" : button.dataset.label; }

  document.addEventListener("DOMContentLoaded", async () => {
    try { await Admin.getSession(); location.replace("/index.html"); return; } catch {}
    $("#login-form").addEventListener("submit", async (event) => {
      event.preventDefault(); const button=event.submitter; busy(button,true); error("");
      try {
        const result = await Admin.request("/api/auth", { method: "POST", mutation: false, body: { action: "login", email: $("#email").value, password: $("#password").value } });
        if (result.step === "2fa" || result.step === "2fa_setup") {
          challenge = result.challenge;
          if (result.step === "2fa_setup") {
            $("#totp-secret").textContent = result.secret; $("#totp-link").href = result.otpauth_url; $("#setup-note").hidden = false;
          } else $("#setup-note").hidden = true;
          step("2fa"); $("#totp-code").focus();
        } else location.replace("/index.html");
      } catch (err) { error(err.message); } finally { busy(button,false); }
    });
    $("#totp-form").addEventListener("submit", async (event) => {
      event.preventDefault(); const button=event.submitter; busy(button,true); error("");
      try { await Admin.request("/api/auth", { method: "POST", body: { action: "verify_2fa", challenge, code: $("#totp-code").value } }); location.replace("/index.html"); }
      catch (err) { error(err.message); $("#totp-code").select(); } finally { busy(button,false); }
    });
    $("#back-login").addEventListener("click", () => { challenge=""; $("#totp-code").value=""; step("login"); });
    $("#copy-secret").addEventListener("click", async () => { await navigator.clipboard.writeText($("#totp-secret").textContent); Admin.toast("Secret copied"); });
  });
})();
