// Lightweight collaborator-facing portal. It uses normal Supabase auth and
// narrow per-user RPCs; no admin data or admin token is available here.
let partnerMode = "login";
let partnerInfo = null;
const partnerById = (id) => document.getElementById(id);
const partnerCash = (n) => "₹" + (Math.max(0, Number(n) || 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
function partnerMessage(id, text, isError) {
  const el = partnerById(id); if (!el) return;
  el.textContent = text || ""; el.classList.toggle("partner-error", !!isError);
}
function setPartnerMode(mode) {
  partnerMode = mode;
  partnerById("partner-login-tab").className = mode === "login" ? "btn btn--primary" : "btn btn--secondary";
  partnerById("partner-signup-tab").className = mode === "signup" ? "btn btn--primary" : "btn btn--secondary";
  partnerById("partner-auth-submit").textContent = mode === "login" ? "Sign in" : "Create account";
  partnerById("partner-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  partnerMessage("partner-auth-message", "");
}
function showPartnerApp(loggedIn) {
  partnerById("partner-auth").classList.toggle("partner-hidden", loggedIn);
  partnerById("partner-dashboard").classList.toggle("partner-hidden", !loggedIn);
}
async function updatePartnerDashboard() {
  const { data, error } = await sb.rpc("affiliate_partner_dashboard");
  if (error) throw error;
  showPartnerApp(true);
  if (!data?.applied) {
    partnerById("partner-apply-card").classList.remove("partner-hidden");
    partnerById("partner-review-card").classList.add("partner-hidden");
    partnerById("partner-approved").classList.add("partner-hidden");
    return;
  }
  partnerInfo = data;
  partnerById("partner-greeting").textContent = `Hi, ${data.publicName || "Partner"}`;
  partnerById("partner-status").textContent = data.status || "pending";
  partnerById("partner-apply-card").classList.toggle("partner-hidden", !(data.status === "rejected" || data.status === "suspended"));
  partnerById("partner-review-card").classList.toggle("partner-hidden", data.status === "approved");
  partnerById("partner-approved").classList.toggle("partner-hidden", data.status !== "approved");
  partnerById("partner-review-status").textContent = data.status || "pending";
  partnerById("partner-review-note").textContent = data.reviewNote || "";
  if (data.status === "rejected" || data.status === "suspended") {
    partnerById("partner-public-name").value = data.publicName || "";
    partnerById("partner-upi").value = data.payoutUpi || "";
  }
  if (data.status !== "approved") return;
  partnerById("partner-sales").textContent = Number(data.salesCount || 0).toLocaleString("en-IN");
  partnerById("partner-pending").textContent = partnerCash(data.pendingPaise);
  partnerById("partner-payable").textContent = partnerCash(data.approvedPaise);
  partnerById("partner-paid").textContent = partnerCash(data.paidPaise);
  partnerById("partner-rate").textContent = `${Number(data.commissionPercent || 0)}%`;
  partnerById("partner-upi-view").textContent = data.payoutUpi || "Not added";
  const coupons = Array.isArray(data.coupons) ? data.coupons : [];
  partnerById("partner-coupons").innerHTML = coupons.length ? coupons.map((c) => {
    const code = String(c.code || "");
    const link = `https://pydebug.in/premium?coupon=${encodeURIComponent(code)}`;
    return `<tr><td><span class="partner-code">${escapeHtml(code)}</span><div><a target="_blank" rel="noopener" href="${escapeHtml(link)}">Share link ↗</a></div></td><td>${Number(c.discountPercent || 0)}% off</td><td>${c.active ? "Active" : "Paused"}</td></tr>`;
  }).join("") : `<tr><td colspan="3" class="partner-muted">No coupon has been assigned yet. Contact PyDebug after approval.</td></tr>`;
  const payouts = Array.isArray(data.payouts) ? data.payouts : [];
  partnerById("partner-payout-history").innerHTML = payouts.length ? payouts.map((p) => `<tr><td>${escapeHtml(p.paidAt ? new Date(p.paidAt).toLocaleDateString("en-IN") : new Date(p.createdAt).toLocaleDateString("en-IN"))}</td><td>${partnerCash(p.amountPaise)}</td><td>${escapeHtml(p.status)}</td><td>${escapeHtml(p.reference || "—")}</td></tr>`).join("") : `<tr><td colspan="4" class="partner-muted">No payouts yet.</td></tr>`;
}
async function refreshPartnerSession() {
  const { data: { session } } = await sb.auth.getSession();
  showPartnerApp(!!session);
  if (session) {
    try { await updatePartnerDashboard(); }
    catch (e) { partnerMessage("partner-main-message", e.message || "Unable to load partner dashboard", true); }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const passwordInput = partnerById("partner-password");
  const passwordToggle = partnerById("partner-password-toggle");
  passwordToggle.addEventListener("click", () => {
    const isHidden = passwordInput.type === "password";
    passwordInput.type = isHidden ? "text" : "password";
    passwordToggle.textContent = isHidden ? "Hide" : "Show";
    passwordToggle.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
    passwordToggle.setAttribute("aria-pressed", String(isHidden));
  });
  partnerById("partner-login-tab").addEventListener("click", () => setPartnerMode("login"));
  partnerById("partner-signup-tab").addEventListener("click", () => setPartnerMode("signup"));
  partnerById("partner-auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = partnerById("partner-email").value.trim();
    const password = partnerById("partner-password").value;
    const submit = partnerById("partner-auth-submit"); submit.disabled = true;
    try {
      if (partnerMode === "signup") {
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: new URL("partner.html", window.location.href).toString() },
        });
        if (error) throw error;
        if (data.session) await refreshPartnerSession();
        else partnerMessage("partner-auth-message", "Account created. Check your email to confirm, then return here and sign in.");
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await refreshPartnerSession();
      }
    } catch (e) { partnerMessage("partner-auth-message", e.message || "Authentication failed", true); }
    finally { submit.disabled = false; }
  });
  partnerById("partner-apply-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!partnerById("partner-terms").checked) return;
    const btn = event.submitter; if (btn) btn.disabled = true;
    try {
      const { error } = await sb.rpc("affiliate_apply", {
        p_public_name: partnerById("partner-public-name").value.trim(),
        p_social_url: partnerById("partner-social-url").value.trim() || null,
        p_payout_upi: partnerById("partner-upi").value.trim() || null,
        p_accept_terms: true,
      });
      if (error) throw error;
      partnerMessage("partner-main-message", "Application submitted. PyDebug will review it.");
      await updatePartnerDashboard();
    } catch (e) { partnerMessage("partner-main-message", e.message || "Could not submit application", true); }
    finally { if (btn) btn.disabled = false; }
  });
  partnerById("partner-update-upi").addEventListener("click", async () => {
    const upi = prompt("Enter your UPI ID. It is visible to you and PyDebug admins for payout processing:", partnerInfo?.payoutUpi || "");
    if (upi === null) return;
    if (!confirm("By updating payout details, you confirm the current Partner Rules & Payout Policy still applies.")) return;
    try {
      const { error } = await sb.rpc("affiliate_apply", { p_public_name: partnerInfo.publicName, p_social_url: partnerInfo.socialUrl || null, p_payout_upi: upi.trim() || null, p_accept_terms: true });
      if (error) throw error;
      await updatePartnerDashboard(); partnerMessage("partner-main-message", "UPI payout details updated.");
    } catch (e) { partnerMessage("partner-main-message", e.message || "Could not update UPI", true); }
  });
  partnerById("partner-logout").addEventListener("click", async () => { await sb.auth.signOut(); partnerInfo = null; showPartnerApp(false); });
  sb.auth.onAuthStateChange((_event, session) => { if (session) setTimeout(() => refreshPartnerSession(), 0); });
  refreshPartnerSession();
});
