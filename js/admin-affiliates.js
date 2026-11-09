// Affiliate partner administration. Every protected operation is repeated in
// SECURITY DEFINER Supabase RPCs; this UI is not the security boundary.
const AffiliateAdmin = { partners: [], coupons: [], payouts: [], commissions: [] };
const affMoney = (paise) => "₹" + (Math.max(0, Number(paise) || 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const affEl = (id) => document.getElementById(id);

onAdminReady(async () => {
  const admin = await requirePerm("coupons.read");
  if (!admin) return;
  affEl("refresh-affiliates")?.addEventListener("click", loadAffiliateAdmin);
  affEl("affiliate-partners")?.addEventListener("click", onPartnerAction);
  affEl("affiliate-coupons")?.addEventListener("click", onCouponAction);
  affEl("affiliate-payouts")?.addEventListener("click", onPayoutAction);
  affEl("affiliate-commissions")?.addEventListener("click", onCommissionAction);
  affEl("affiliate-link-form")?.addEventListener("submit", linkAffiliateCoupon);
  affEl("create-sunday-run")?.addEventListener("click", createSundayRun);
  await loadAffiliateAdmin();
});

async function affiliateRpc(name, args) {
  const { data, error } = await sb.rpc(name, args || {});
  if (error) throw error;
  return data;
}
function affiliateError(error) {
  const msg = String(error?.message || error || "Request failed");
  if (/function.*not found|schema cache|PGRST202/i.test(msg)) return "Affiliate database migration not installed. Run db/migrations/20261109_affiliate_partners_weekly_payouts.sql in Supabase SQL Editor first.";
  return msg;
}
function affiliateNotice(text, bad) {
  const box = affEl("affiliate-message");
  if (!box) return;
  box.innerHTML = `<div class="admin-hint ${bad ? "affiliate-error" : ""}">${escapeHtml(text)}</div>`;
  if (!bad) setTimeout(() => { if (box.textContent === text) box.innerHTML = ""; }, 6000);
}
async function loadAffiliateAdmin() {
  const btn = affEl("refresh-affiliates"); if (btn) btn.disabled = true;
  try {
    const [partners, coupons, payouts, commissions] = await Promise.all([
      affiliateRpc("affiliate_admin_list_partners"),
      affiliateRpc("affiliate_admin_list_coupons"),
      affiliateRpc("affiliate_admin_list_payouts"),
      affiliateRpc("affiliate_admin_list_commissions"),
    ]);
    AffiliateAdmin.partners = Array.isArray(partners) ? partners : [];
    AffiliateAdmin.coupons = Array.isArray(coupons) ? coupons : [];
    AffiliateAdmin.payouts = Array.isArray(payouts) ? payouts : [];
    AffiliateAdmin.commissions = Array.isArray(commissions) ? commissions : [];
    renderAffiliatePartners(); renderAffiliateCoupons(); renderAffiliatePayouts(); renderAffiliateCommissions(); renderAffiliateStats();
  } catch (e) {
    affiliateNotice(affiliateError(e), true);
    ["affiliate-partners", "affiliate-coupons", "affiliate-payouts", "affiliate-commissions"].forEach((id) => {
      const tbody = affEl(id); if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Could not load data</td></tr>`;
    });
  } finally { if (btn) btn.disabled = false; }
}
function renderAffiliateStats() {
  const p = AffiliateAdmin.partners;
  const due = AffiliateAdmin.payouts.filter((x) => x.status === "pending").reduce((n, x) => n + Number(x.amount_paise || 0), 0)
    + p.reduce((n, x) => n + Number(x.approved_paise || 0), 0);
  const paid = p.reduce((n, x) => n + Number(x.paid_paise || 0), 0);
  affEl("partner-count").textContent = String(p.length);
  affEl("affiliate-stat-pending").textContent = String(p.filter((x) => x.status === "pending").length);
  affEl("affiliate-stat-partners").textContent = String(p.filter((x) => x.status === "approved").length);
  affEl("affiliate-stat-payable").textContent = affMoney(due);
  affEl("affiliate-stat-paid").textContent = affMoney(paid);
}
function renderAffiliatePartners() {
  const tbody = affEl("affiliate-partners");
  if (!AffiliateAdmin.partners.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No applications yet.</td></tr>`; }
  else tbody.innerHTML = AffiliateAdmin.partners.map((p) => {
    const id = escapeHtml(p.user_id);
    return `<tr data-partner-row="${id}">
      <td><strong>${escapeHtml(p.public_name)}</strong><div class="affiliate-muted">${escapeHtml(p.email || "")}</div>${p.social_url ? `<a target="_blank" rel="noopener" href="${escapeHtml(p.social_url)}">Profile ↗</a>` : ""}</td>
      <td><span class="affiliate-status affiliate-status--${escapeHtml(p.status)}">${escapeHtml(p.status)}</span><div class="affiliate-muted">${new Date(p.applied_at).toLocaleDateString("en-IN")}</div>${p.review_note ? `<div class="affiliate-muted">${escapeHtml(p.review_note)}</div>` : ""}</td>
      <td><input class="affiliate-inline-number" data-partner-discount type="number" min="0" max="80" value="${Number(p.default_discount_percent ?? 10)}" aria-label="Default discount percentage"></td>
      <td><input class="affiliate-inline-number" data-partner-rate type="number" min="0" max="50" step="0.5" value="${Number(p.commission_percent ?? 20)}" aria-label="Commission percentage">%</td>
      <td>${Number(p.sales_count || 0)} sales<div class="affiliate-muted">pending ${affMoney(p.pending_paise)} · payable ${affMoney(p.approved_paise)}</div><div class="affiliate-muted">paid ${affMoney(p.paid_paise)}</div></td>
      <td class="affiliate-actions"><button class="btn btn--primary btn--sm" data-partner-status="approved">Approve / Save</button><button class="btn btn--secondary btn--sm" data-partner-status="rejected">Reject</button>${p.status === "approved" ? `<button class="btn btn--secondary btn--sm" data-partner-status="suspended">Suspend</button>` : ""}</td>
    </tr>`;
  }).join("");
  const select = affEl("affiliate-coupon-partner");
  if (select) select.innerHTML = `<option value="">Select partner…</option>` + AffiliateAdmin.partners.filter((p) => p.status === "approved").map((p) => `<option value="${escapeHtml(p.user_id)}">${escapeHtml(p.public_name)} · ${Number(p.commission_percent)}%</option>`).join("");
}
function renderAffiliateCoupons() {
  const tbody = affEl("affiliate-coupons");
  if (!AffiliateAdmin.coupons.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty-row">No coupons found.</td></tr>`; return; }
  tbody.innerHTML = AffiliateAdmin.coupons.map((c) => `<tr>
    <td><code>${escapeHtml(c.code)}</code>${c.is_active ? "" : `<span class="affiliate-muted"> · paused</span>`}</td>
    <td>${Number(c.discount_percent || 0)}%</td><td>${escapeHtml(c.partner_name || "Unassigned")}</td>
    <td>${c.commission_percent == null ? "—" : `${Number(c.commission_percent)}%`}</td>
    <td>${c.affiliate_partner_id ? `<button class="btn btn--secondary btn--sm" data-unlink-coupon="${escapeHtml(c.code)}">Unassign</button>` : "—"}</td></tr>`).join("");
}
function renderAffiliateCommissions() {
  const tbody = affEl("affiliate-commissions");
  if (!AffiliateAdmin.commissions.length) { tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No affiliate sales recorded yet.</td></tr>`; return; }
  tbody.innerHTML = AffiliateAdmin.commissions.map((c) => `<tr>
    <td><strong>${escapeHtml(c.partner_name)}</strong><div class="affiliate-muted">${escapeHtml(c.coupon_code)}</div></td>
    <td><code>${escapeHtml(c.payment_id)}</code><div class="affiliate-muted">${new Date(c.created_at).toLocaleDateString("en-IN")}</div></td>
    <td>${escapeHtml(c.plan_key || "Premium")}</td><td>${affMoney(c.sale_amount_paise)}</td>
    <td>${affMoney(c.commission_paise)} <div class="affiliate-muted">${Number(c.commission_percent)}%</div></td>
    <td><span class="affiliate-status affiliate-status--${escapeHtml(c.status)}">${escapeHtml(c.status)}</span><div class="affiliate-muted">eligible ${new Date(c.eligible_at).toLocaleDateString("en-IN")}</div></td>
    <td>${["pending", "approved"].includes(c.status) ? `<button class="btn btn--secondary btn--sm" data-adjust-payment="${escapeHtml(c.payment_id)}">Partial refund</button> <button class="btn btn--secondary btn--sm" data-reverse-payment="${escapeHtml(c.payment_id)}">Full refund</button>` : "—"}</td></tr>`).join("");
}
function renderAffiliatePayouts() {
  const tbody = affEl("affiliate-payouts");
  if (!AffiliateAdmin.payouts.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No Sunday payout runs yet.</td></tr>`; return; }
  tbody.innerHTML = AffiliateAdmin.payouts.map((p) => `<tr>
    <td>${escapeHtml(p.period_start)} → ${escapeHtml(p.period_end)}</td><td><strong>${escapeHtml(p.partner_name)}</strong><div class="affiliate-muted">${escapeHtml(p.payout_upi || "UPI not supplied")}</div></td>
    <td><strong>${affMoney(p.amount_paise)}</strong></td><td>${Number(p.commissions_count || 0)}</td><td><span class="affiliate-status affiliate-status--${escapeHtml(p.status)}">${escapeHtml(p.status)}</span></td>
    <td>${p.status === "pending" ? `<button class="btn btn--primary btn--sm" data-mark-paid="${escapeHtml(p.payout_id)}">Mark paid</button> <button class="btn btn--secondary btn--sm" data-mark-failed="${escapeHtml(p.payout_id)}">Failed</button>` : escapeHtml(p.payment_reference || "—")}</td></tr>`).join("");
}
async function onPartnerAction(event) {
  const button = event.target.closest("[data-partner-status]"); if (!button) return;
  const row = button.closest("[data-partner-row]"); if (!row) return;
  const status = button.dataset.partnerStatus;
  const userId = row.dataset.partnerRow;
  const commission = Number(row.querySelector("[data-partner-rate]").value);
  const discount = Number(row.querySelector("[data-partner-discount]").value);
  const note = status === "rejected" || status === "suspended" ? (prompt("Optional note for the collaborator:") || "") : "";
  button.disabled = true;
  try {
    await affiliateRpc("affiliate_admin_review_partner", { p_user_id: userId, p_status: status, p_commission_percent: commission, p_discount_percent: discount, p_note: note });
    affiliateNotice(`${status === "approved" ? "Partner approved / settings saved" : `Partner ${status}`}.`);
    await loadAffiliateAdmin();
  } catch (e) { affiliateNotice(affiliateError(e), true); button.disabled = false; }
}
async function linkAffiliateCoupon(event) {
  event.preventDefault();
  const code = affEl("affiliate-coupon-code").value.trim().toUpperCase();
  const partner = affEl("affiliate-coupon-partner").value;
  const rawRate = affEl("affiliate-coupon-rate").value.trim();
  const rate = rawRate === "" ? null : Number(rawRate);
  const submit = event.submitter; if (submit) submit.disabled = true;
  try {
    await affiliateRpc("affiliate_admin_link_coupon", { p_code: code, p_partner_user_id: partner, p_commission_percent: rate });
    affEl("affiliate-link-form").reset(); affiliateNotice(`${code} assigned. Future successful payments will earn the configured rate.`); await loadAffiliateAdmin();
  } catch (e) { affiliateNotice(affiliateError(e), true); }
  finally { if (submit) submit.disabled = false; }
}
async function onCouponAction(event) {
  const button = event.target.closest("[data-unlink-coupon]"); if (!button) return;
  if (!confirm(`Unassign ${button.dataset.unlinkCoupon} from its partner? Past sales will remain attributed.`)) return;
  button.disabled = true;
  try { await affiliateRpc("affiliate_admin_link_coupon", { p_code: button.dataset.unlinkCoupon, p_partner_user_id: null, p_commission_percent: null }); affiliateNotice("Coupon unassigned. Existing commission history is unchanged."); await loadAffiliateAdmin(); }
  catch (e) { affiliateNotice(affiliateError(e), true); button.disabled = false; }
}
async function createSundayRun() {
  if (!confirm("Create today's Sunday payout run from eligible, unpaid commissions? This groups each collaborator's amount for manual transfer.")) return;
  const button = affEl("create-sunday-run"); button.disabled = true;
  try { await affiliateRpc("affiliate_admin_create_sunday_payout_run"); affiliateNotice("Sunday payout run prepared. Transfer each amount, then record its reference."); await loadAffiliateAdmin(); }
  catch (e) { affiliateNotice(affiliateError(e), true); }
  finally { button.disabled = false; }
}
async function onCommissionAction(event) {
  const adjust = event.target.closest("[data-adjust-payment]");
  const reverse = event.target.closest("[data-reverse-payment]");
  const button = adjust || reverse; if (!button) return;
  const paymentId = adjust ? adjust.dataset.adjustPayment : reverse.dataset.reversePayment;
  const reason = prompt(`Reason for refund adjustment for ${paymentId}:`, "Razorpay refund/chargeback verified");
  if (!reason) return;
  if (adjust) {
    const sale = AffiliateAdmin.commissions.find((item) => item.payment_id === paymentId);
    const originalRupees = Number(sale?.sale_amount_paise || 0) / 100;
    const raw = prompt("Enter revised net customer-paid total in ₹ after partial refund (not refund amount):", originalRupees.toFixed(2));
    if (raw === null || !Number.isFinite(Number(raw)) || Number(raw) < 0) return;
    if (!confirm("This recalculates the unpaid commission on the revised net paid amount. Verify the Razorpay refund first.")) return;
    button.disabled = true;
    try {
      await affiliateRpc("affiliate_admin_adjust_commission", { p_payment_id: paymentId, p_new_sale_amount_paise: Math.round(Number(raw) * 100), p_reason: reason });
      affiliateNotice("Commission adjusted to the verified net paid amount."); await loadAffiliateAdmin();
    } catch (e) { affiliateNotice(affiliateError(e), true); button.disabled = false; }
    return;
  }
  if (!confirm("This permanently reverses the unpaid affiliate commission. Verify the full refund/chargeback in Razorpay first.")) return;
  button.disabled = true;
  try {
    await affiliateRpc("affiliate_admin_reverse_commission", { p_payment_id: paymentId, p_reason: reason });
    affiliateNotice("Commission reversed. Process the customer refund separately in Razorpay."); await loadAffiliateAdmin();
  } catch (e) { affiliateNotice(affiliateError(e), true); button.disabled = false; }
}
async function onPayoutAction(event) {
  const paid = event.target.closest("[data-mark-paid]");
  const failed = event.target.closest("[data-mark-failed]");
  const button = paid || failed; if (!button) return;
  const status = paid ? "paid" : "failed";
  const reference = paid ? prompt("Paste RazorpayX / bank transfer reference (required):") : prompt("Reason for failed transfer (optional):");
  if (paid && !reference) return;
  button.disabled = true;
  try {
    await affiliateRpc("affiliate_admin_mark_payout", { p_payout_id: button.dataset[paid ? "markPaid" : "markFailed"], p_status: status, p_payment_reference: reference || null });
    affiliateNotice(status === "paid" ? "Payout recorded as paid." : "Payout marked failed and returned to payable balance."); await loadAffiliateAdmin();
  } catch (e) { affiliateNotice(affiliateError(e), true); button.disabled = false; }
}
