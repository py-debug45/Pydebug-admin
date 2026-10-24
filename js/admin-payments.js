// admin-payments.js — verified revenue ledger + Razorpay checkout funnel + product entitlements.

let activePayTab = "grants";
let allGrants = [];
let filteredGrants = [];
let allOrders = [];
let filteredOrders = [];
let allEntitlements = [];
let payUserMap = {};
const PAY_PAGE_SIZE = 100;
let payVisibleCount = PAY_PAGE_SIZE;

onAdminReady(async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  bindPayTabs();
  await loadAllPaymentData();

  document.getElementById("payment-search").addEventListener("input", debounce(applyPaymentFilters, 250));
  document.getElementById("payment-filter-plan").addEventListener("change", applyPaymentFilters);
  document.getElementById("payments-load-more").addEventListener("click", () => {
    payVisibleCount += PAY_PAGE_SIZE;
    renderPayments();
  });

  document.getElementById("order-search").addEventListener("input", debounce(applyOrderFilters, 250));
  const orderPlanEl = document.getElementById("order-filter-plan");
  if (orderPlanEl) orderPlanEl.addEventListener("change", applyOrderFilters);
  document.getElementById("order-filter-state").addEventListener("change", applyOrderFilters);

  document.getElementById("entitlement-form").addEventListener("submit", submitEntitlementGrant);
  document.getElementById("refresh-payments-btn").addEventListener("click", loadAllPaymentData);
  document.getElementById("export-payments-btn").addEventListener("click", exportPayments);
});

function bindPayTabs() {
  document.querySelectorAll("[data-pay-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activePayTab = btn.dataset.payTab;
      document.querySelectorAll("[data-pay-tab]").forEach((b) => b.classList.toggle("is-active", b === btn));
      document.querySelectorAll(".admin-tab-panel").forEach((p) => {
        p.classList.toggle("is-active", p.id === `panel-${activePayTab}`);
      });
    });
  });
}

function displayNameOf(u) {
  if (!u) return "—";
  return u.display_name || u.full_name || u.email || "—";
}

async function loadAllPaymentData() {
  const refreshBtn = document.getElementById("refresh-payments-btn");
  if (refreshBtn) refreshBtn.disabled = true;
  document.getElementById("payments-tbody").innerHTML = `<tr><td colspan="6" class="empty-row">Loading payments...</td></tr>`;
  document.getElementById("payments-hint").innerHTML = "";

  const [grantsRes, ordersRes, entRes] = await Promise.allSettled([
    fetchAdminRows("payment_grants", "*", "payment_id"),
    fetchAdminRows("payment_orders", "*", "created_at"),
    fetchAdminRows("product_entitlements", "*", "updated_at"),
  ]);

  if (grantsRes.status === "rejected") {
    document.getElementById("payments-tbody").innerHTML = `<tr><td colspan="6" class="empty-row">Could not load payments.</td></tr>`;
    document.getElementById("payments-hint").innerHTML =
      `<div class="admin-hint">Couldn't read <code>payment_grants</code> (${escapeHtml(grantsRes.reason?.message || "")}).</div>`;
    if (refreshBtn) refreshBtn.disabled = false;
    return;
  }

  const secondaryWarnings = [];
  if (ordersRes.status === "rejected") {
    secondaryWarnings.push(`payment_orders: ${ordersRes.reason?.message || "unavailable"}`);
  }
  if (entRes.status === "rejected") {
    secondaryWarnings.push(`product_entitlements: ${entRes.reason?.message || "unavailable"}`);
  }
  if (secondaryWarnings.length) {
    document.getElementById("payments-hint").innerHTML =
      `<div class="admin-hint">Some payment tables could not be read (${escapeHtml(secondaryWarnings.join("; "))}). Run the latest SQL migration in Supabase.</div>`;
  }

  allOrders = ordersRes.status === "fulfilled"
    ? ordersRes.value.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    : [];
  allEntitlements = entRes.status === "fulfilled"
    ? entRes.value.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
    : [];

  const orderById = {};
  allOrders.forEach((o) => {
    if (o.order_id) orderById[o.order_id] = o;
  });

  // The ledger is authoritative for what was charged. If a grant predates
  // amount capture, borrow the linked order's amount / coupon so the panel
  // still shows the real price the learner paid.
  allGrants = (grantsRes.value || [])
    .map((g) => {
      const order = orderById[g.order_id] || null;
      const orderAmount = order && Number.isFinite(Number(order.amount)) ? Number(order.amount) : null;
      const orderPct = order && Number.isFinite(Number(order.discount_percent)) ? Number(order.discount_percent) : 0;
      return {
        ...g,
        coupon_code: g.coupon_code || (order && order.coupon_code) || null,
        discount_percent: Number(g.discount_percent) > 0 ? Number(g.discount_percent) : orderPct,
        order_amount_paise: orderAmount,
      };
    })
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  const userIds = new Set();
  allGrants.forEach((g) => { if (g.user_id) userIds.add(g.user_id); });
  allOrders.forEach((o) => { if (o.user_id) userIds.add(o.user_id); });
  allEntitlements.forEach((e) => { if (e.user_id) userIds.add(e.user_id); });

  payUserMap = {};
  const idList = [...userIds];
  for (let i = 0; i < idList.length; i += 200) {
    const { data: users } = await sb.from("profiles").select("id, display_name, full_name, email").in("id", idList.slice(i, i + 200));
    (users || []).forEach((u) => { payUserMap[u.id] = u; });
  }

  document.getElementById("tab-count-grants").textContent = allGrants.length;
  document.getElementById("tab-count-orders").textContent = allOrders.length;
  document.getElementById("tab-count-entitlements").textContent = allEntitlements.length;

  renderPaymentStats();
  renderPlanCharts();
  applyPaymentFilters();
  applyOrderFilters();
  renderEntitlements();

  if (refreshBtn) refreshBtn.disabled = false;
}

function renderPaymentStats() {
  const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const total = allGrants.reduce((s, g) => s + grantAmountPaise(g), 0);
  const monthTotal = allGrants
    .filter((g) => new Date(g.created_at).getTime() >= monthAgo)
    .reduce((s, g) => s + grantAmountPaise(g), 0);

  const discountTotal = allGrants.reduce((s, g) => s + grantDiscountPaise(g), 0);
  const discountedCount = allGrants.filter((g) => grantDiscountPercent(g) > 0).length;
  const estimatedCount = allGrants.filter((g) => grantAmountIsEstimated(g)).length;

  const paidOrderIds = new Set(allGrants.map((g) => g.order_id).filter(Boolean));
  const convertedOrders = allOrders.filter((o) => paidOrderIds.has(o.order_id)).length;
  const abandonedOrders = Math.max(0, allOrders.length - convertedOrders);
  const convPct = allOrders.length ? Math.round((convertedOrders / allOrders.length) * 100) + "% order conversion" : "no checkout orders yet";

  document.getElementById("pay-total-revenue").textContent = fmtINR(total / 100);
  document.getElementById("pay-month-revenue").textContent = fmtINR(monthTotal / 100);
  document.getElementById("pay-count").textContent = allGrants.length.toLocaleString("en-IN");
  document.getElementById("pay-discount").textContent = fmtINR(discountTotal / 100);
  document.getElementById("pay-discount-sub").textContent = discountedCount
    ? `on ${discountedCount.toLocaleString("en-IN")} discounted purchase${discountedCount === 1 ? "" : "s"}`
    : "no discounted purchases";
  document.getElementById("pay-orders-dropoff").textContent = abandonedOrders.toLocaleString("en-IN");
  document.getElementById("pay-conversion-rate").textContent = convPct;
  document.getElementById("pay-avg").textContent = allGrants.length ? fmtINR(total / allGrants.length / 100) : fmtINR(0);
  const revenueSub = document.getElementById("pay-total-revenue-sub");
  if (revenueSub) {
    revenueSub.textContent = estimatedCount
      ? `${estimatedCount} legacy amount${estimatedCount === 1 ? "" : "s"} not recorded (list price used)`
      : "actually charged by Razorpay";
  }

  const sachetRoot = document.getElementById("sachet-conversion-root");
  if (sachetRoot) {
    sachetRoot.innerHTML = renderSachetCardHtml(computeSachetMetrics(allGrants));
  }
}

function planChartColor(planKey, fallbackIdx) {
  const palette = {
    weekly: CHART_COLORS.mint,
    monthly: CHART_COLORS.amber,
    yearly: CHART_COLORS.blue,
    exam_pack: CHART_COLORS.purple,
    sixmonth: "#94a3b8",
  };
  const fallback = [CHART_COLORS.mint, CHART_COLORS.amber, CHART_COLORS.purple, CHART_COLORS.blue];
  return palette[planKey] || fallback[fallbackIdx % fallback.length];
}

function renderPlanCharts() {
  const byPlan = {};
  allGrants.forEach((g) => {
    const k = g.plan_key || "unknown";
    byPlan[k] = byPlan[k] || { count: 0, revenue: 0 };
    byPlan[k].count++;
    byPlan[k].revenue += grantAmountPaise(g);
  });
  const order = ["weekly", "monthly", "yearly", "sixmonth", "exam_pack"];
  const keys = Object.keys(byPlan).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  document.getElementById("chart-plan-revenue").innerHTML = keys.length
    ? svgDonut(keys.map((k, i) => ({
        label: `${planLabel(k)} (${formatPaiseINR(byPlan[k].revenue)})`,
        value: byPlan[k].revenue,
        color: planChartColor(k, i),
      })))
    : `<div class="chart-empty">No payments yet</div>`;
  document.getElementById("chart-plan-count").innerHTML = keys.length
    ? svgDonut(keys.map((k, i) => ({ label: planLabel(k), value: byPlan[k].count, color: planChartColor(k, i) })))
    : `<div class="chart-empty">No payments yet</div>`;
}

function applyPaymentFilters() {
  const search = document.getElementById("payment-search").value.trim().toLowerCase();
  const plan = document.getElementById("payment-filter-plan").value;

  filteredGrants = allGrants.filter((g) => {
    if (plan !== "all" && g.plan_key !== plan && g.product_key !== plan) return false;
    if (search) {
      const u = payUserMap[g.user_id] || {};
      const hay = `${u.email || ""} ${u.display_name || ""} ${u.full_name || ""} ${g.payment_id || ""} ${g.order_id || ""} ${g.coupon_code || ""} ${planLabel(g.plan_key)}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  payVisibleCount = PAY_PAGE_SIZE;
  renderPayments();
}

function renderPayments() {
  const tbody = document.getElementById("payments-tbody");
  tbody.innerHTML = "";

  if (!filteredGrants.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-row">No payments found.</td></tr>`;
    document.getElementById("payments-load-more").style.display = "none";
    return;
  }

  tbody.innerHTML = filteredGrants.slice(0, payVisibleCount).map((g) => {
    const u = payUserMap[g.user_id] || {};
    const paid = grantPaidPaise(g);
    const estimated = paid === null;
    const charged = grantAmountPaise(g);
    const list = grantListAmountPaise(g);
    const pct = grantDiscountPercent(g);
    const saved = grantDiscountPaise(g);
    const left = premiumTimeLeft(g.expires_at);
    const until = g.expires_at
      ? `<span class="${left.expired ? "muted" : ""}">${escapeHtml(fmtDateTime(g.expires_at))}</span>
         <div class="muted" style="font-size:0.74rem">${escapeHtml(left.label)}</div>`
      : `<span class="muted">No expiry</span>`;
    const discount = pct > 0
      ? `<span class="tag tag--solved">${pct}% off</span>
         <div class="muted" style="font-size:0.74rem">${escapeHtml(g.coupon_code || "coupon")}${saved ? ` · ${escapeHtml(formatPaiseINR(saved))} saved` : ""}</div>`
      : `<span class="muted">—</span>`;
    const amountCell = estimated
      ? `<strong title="Actual Razorpay amount was never recorded for this legacy payment — showing the plan list price.">${escapeHtml(formatPaiseINR(charged))}*</strong>
         <div><button type="button" class="btn btn--secondary btn--sm" style="padding:2px 7px;font-size:.7rem;margin-top:4px"
            data-grant-amount="${escapeHtml(g.payment_id || "")}" data-grant-list="${list}">Set paid ₹</button></div>`
      : `<strong>${escapeHtml(formatPaiseINR(paid))}</strong>`;
    return `<tr>
      <td title="${escapeHtml(fmtDateTime(g.created_at))}">
        ${escapeHtml(fmtDateTime(g.created_at))}
        <div class="muted" style="font-size:0.74rem">${escapeHtml(timeAgo(g.created_at))}</div>
      </td>
      <td>
        <a href="user-detail.html?id=${encodeURIComponent(g.user_id || "")}">${escapeHtml(displayNameOf(u))}</a>
        <div class="muted" style="font-size:0.75rem">${escapeHtml(u.email || "")}</div>
      </td>
      <td>${planBadge(g.plan_key)}</td>
      <td class="muted">${pct > 0 ? `<s>${escapeHtml(formatPaiseINR(list))}</s>` : escapeHtml(formatPaiseINR(list))}</td>
      <td>${amountCell}</td>
      <td>${discount}</td>
      <td>${until}</td>
      <td class="mono muted" title="Order: ${escapeHtml(g.order_id || "")}">${escapeHtml((g.payment_id || "").slice(0, 20))}
        <div style="font-size:0.7rem">${escapeHtml((g.order_id || "").slice(0, 20))}</div>
      </td>
    </tr>`;
  }).join("");

  document.getElementById("payments-load-more").style.display =
    filteredGrants.length > payVisibleCount ? "" : "none";

  if (tbody.dataset.bound !== "1") {
    tbody.dataset.bound = "1";
    tbody.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-grant-amount]");
      if (!btn) return;
      recordPaidAmount(btn);
    });
  }
}

// Legacy grants written before payment_grants.amount_paise was populated have
// no real charged amount anywhere. Let the admin type the Razorpay figure; the
// RPC re-checks is_admin() and writes an audit-log entry.
async function recordPaidAmount(btn) {
  const paymentId = btn.dataset.grantAmount;
  if (!paymentId) return;
  const suggested = Number(btn.dataset.grantList) || 0;
  const answer = window.prompt(
    `Actual amount Razorpay charged for ${paymentId} (in ₹):`,
    suggested ? String(Math.round(suggested / 100)) : ""
  );
  if (answer === null) return;
  const rupees = Number(String(answer).replace(/[₹,\s]/g, ""));
  if (!Number.isFinite(rupees) || rupees < 0) {
    showToast("Enter a valid amount in ₹", "error");
    return;
  }

  btn.disabled = true;
  const { error } = await sb.rpc("admin_record_grant_amount", {
    p_payment_id: paymentId,
    p_amount_paise: Math.round(rupees * 100),
  });
  if (error) {
    btn.disabled = false;
    showToast(explainPaymentError(error), "error");
    return;
  }
  showToast(`Recorded ${fmtINR(rupees)} as the paid amount`, "success");
  await loadAllPaymentData();
}

function explainPaymentError(error) {
  const message = error && error.message ? error.message : String(error || "Unknown error");
  if (/could not find the function|does not exist|schema cache/i.test(message)) {
    return "Run db/migrations/20261024_payment_actual_amounts.sql in Supabase, then retry.";
  }
  return message;
}

function applyOrderFilters() {
  const paidOrderIds = new Set(allGrants.map((g) => g.order_id).filter(Boolean));
  const search = document.getElementById("order-search").value.trim().toLowerCase();
  const planEl = document.getElementById("order-filter-plan");
  const plan = planEl ? planEl.value : "all";
  const state = document.getElementById("order-filter-state").value;

  filteredOrders = allOrders.filter((o) => {
    const isPaid = paidOrderIds.has(o.order_id);
    if (plan !== "all" && o.plan_key !== plan && o.product_key !== plan) return false;
    if (state === "abandoned" && isPaid) return false;
    if (state === "converted" && !isPaid) return false;
    if (search) {
      const u = payUserMap[o.user_id] || {};
      const hay = `${o.order_id || ""} ${u.email || ""} ${u.display_name || ""} ${u.full_name || ""} ${o.coupon_code || ""} ${planLabel(o.plan_key)}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const tbody = document.getElementById("orders-tbody");
  if (!filteredOrders.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-row">No checkout orders match your filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = filteredOrders.slice(0, 150).map((o) => {
    const u = payUserMap[o.user_id] || {};
    const isPaid = paidOrderIds.has(o.order_id);
    const pct = Math.max(0, Math.min(99, Number(o.discount_percent) || 0));
    const paid = Number.isFinite(Number(o.amount)) ? Number(o.amount) : planAmountPaise(o.plan_key);
    const list = pct > 0 ? Math.round((paid * 100) / (100 - pct)) : (planAmountPaise(o.plan_key) || paid);
    const discount = pct > 0
      ? `<span class="tag tag--solved">${pct}% off</span>
         <div class="muted" style="font-size:0.74rem">${escapeHtml(o.coupon_code || "coupon")} · ${escapeHtml(formatPaiseINR(Math.max(0, list - paid)))} off</div>`
      : `<span class="muted">—</span>`;
    return `<tr>
      <td title="${escapeHtml(fmtDateTime(o.created_at))}">
        ${escapeHtml(fmtDateTime(o.created_at))}
        <div class="muted" style="font-size:0.74rem">${escapeHtml(timeAgo(o.created_at))}</div>
      </td>
      <td>
        <a href="user-detail.html?id=${encodeURIComponent(o.user_id || "")}">${escapeHtml(displayNameOf(u))}</a>
        <div class="muted" style="font-size:0.74rem">${escapeHtml(u.email || "")}</div>
      </td>
      <td>${planBadge(o.plan_key, "tag--info")}</td>
      <td class="muted">${pct > 0 ? `<s>${escapeHtml(formatPaiseINR(list))}</s>` : escapeHtml(formatPaiseINR(list))}</td>
      <td><strong>${escapeHtml(formatPaiseINR(paid))}</strong></td>
      <td>${discount}</td>
      <td>${isPaid ? statusBadge("paid") : '<span class="tag tag--attempted">Abandoned</span>'}</td>
      <td class="mono muted">${escapeHtml(o.order_id || "—")}</td>
    </tr>`;
  }).join("");
}

function renderEntitlements() {
  const tbody = document.getElementById("entitlements-tbody");
  if (!allEntitlements.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No separate product entitlements issued yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = allEntitlements.map((e) => {
    const u = payUserMap[e.user_id] || {};
    const active = !e.expires_at || new Date(e.expires_at) > new Date();
    return `<tr>
      <td>
        <a href="user-detail.html?id=${encodeURIComponent(e.user_id || "")}">${escapeHtml(displayNameOf(u))}</a>
        <div class="muted" style="font-size:0.74rem">${escapeHtml(u.email || e.user_id || "")}</div>
      </td>
      <td><span class="tag tag--premium">${escapeHtml(e.product_key)}</span></td>
      <td class="muted">${escapeHtml(fmtDateTime(e.expires_at))}</td>
      <td>${active ? statusBadge("active") : statusBadge("expired")}</td>
      <td class="muted">${escapeHtml(timeAgo(e.updated_at))}</td>
      <td>
        <button class="btn btn--danger btn--sm" data-revoke-ent-user="${escapeHtml(e.user_id)}" data-revoke-ent-prod="${escapeHtml(e.product_key)}">Revoke</button>
      </td>
    </tr>`;
  }).join("");

  if (tbody.dataset.bound !== "1") {
    tbody.dataset.bound = "1";
    tbody.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button[data-revoke-ent-user]");
      if (!btn) return;
      if (!confirm(`Revoke ${btn.dataset.revokeEntProd} entitlement for this learner?`)) return;
      btn.disabled = true;
      const { error } = await sb.rpc("admin_manage_entitlement", {
        target_user: btn.dataset.revokeEntUser,
        target_product: btn.dataset.revokeEntProd,
        expires: null,
        revoke: true,
      });
      if (error) {
        showToast(error.message, "error");
        btn.disabled = false;
        return;
      }
      showToast("Entitlement revoked", "success");
      await loadAllPaymentData();
    });
  }
}

async function submitEntitlementGrant(e) {
  e.preventDefault();
  const raw = document.getElementById("ent-user").value.trim();
  const product = document.getElementById("ent-product").value;
  const days = Math.max(1, parseInt(document.getElementById("ent-days").value, 10) || 365);

  if (!raw) return;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let profile = null;

  if (uuidRe.test(raw)) {
    const { data } = await sb.from("profiles").select("id, is_premium, premium_expires_at").eq("id", raw).maybeSingle();
    profile = data || { id: raw };
  } else {
    const { data, error } = await sb.from("profiles").select("id, is_premium, premium_expires_at").ilike("email", sanitizeIlike(raw)).maybeSingle();
    if (error || !data) {
      showToast("No learner found with that email or UUID", "error");
      return;
    }
    profile = data;
  }

  const userId = profile.id;
  const existingEnt = allEntitlements.find((item) => item.user_id === userId && item.product_key === product);
  const existingEntMs = existingEnt && existingEnt.expires_at ? new Date(existingEnt.expires_at).getTime() : 0;
  const existingProMs = product === "pro" && profile.premium_expires_at ? new Date(profile.premium_expires_at).getTime() : 0;
  const baseMs = Math.max(
    Date.now(),
    Number.isFinite(existingEntMs) ? existingEntMs : 0,
    Number.isFinite(existingProMs) ? existingProMs : 0
  );
  const expires = new Date(baseMs + days * 86400000).toISOString();

  const { error } = await sb.rpc("admin_manage_entitlement", {
    target_user: userId,
    target_product: product,
    expires,
    revoke: false,
  });
  if (error) {
    showToast("Grant failed: " + error.message, "error");
    return;
  }

  // Keep profiles.is_premium & premium_expires_at in sync when granting Pro.
  if (product === "pro") {
    await sb.rpc("admin_panel_update_profile", {
      target_user: userId,
      patch: { is_premium: true, premium_expires_at: expires },
    });
  }

  const durationLabel = days === 7 ? "7 Days (Pro 7-Day Pass)" : `${days} days`;
  showToast(`Granted ${product} for ${durationLabel}`, "success");
  document.getElementById("ent-user").value = "";
  await loadAllPaymentData();
}

function exportPayments() {
  if (activePayTab === "orders") {
    const paidOrderIds = new Set(allGrants.map((g) => g.order_id).filter(Boolean));
    downloadCSV("pydebug-checkout-orders.csv", filteredOrders.map((o) => {
      const pct = Math.max(0, Math.min(99, Number(o.discount_percent) || 0));
      const paid = Number.isFinite(Number(o.amount)) ? Number(o.amount) : planAmountPaise(o.plan_key);
      const list = pct > 0 ? Math.round((paid * 100) / (100 - pct)) : (planAmountPaise(o.plan_key) || paid);
      return {
        order_id: o.order_id,
        created_at: o.created_at,
        user: (payUserMap[o.user_id] || {}).email || o.user_id,
        plan: o.plan_key,
        plan_label: planLabel(o.plan_key),
        list_price_inr: (list / 100).toFixed(2),
        amount_inr: (paid / 100).toFixed(2),
        coupon_code: o.coupon_code || "",
        discount_percent: pct || "",
        discount_inr: (Math.max(0, list - paid) / 100).toFixed(2),
        status: paidOrderIds.has(o.order_id) ? "converted" : "abandoned",
      };
    }));
    return;
  }
  downloadCSV("pydebug-payments.csv", filteredGrants.map((g) => ({
    payment_id: g.payment_id,
    order_id: g.order_id,
    purchased_at: g.created_at,
    user: (payUserMap[g.user_id] || {}).email || g.user_id,
    plan: g.plan_key,
    plan_label: planLabel(g.plan_key),
    list_price_inr: (grantListAmountPaise(g) / 100).toFixed(2),
    amount_paid_inr: (grantAmountPaise(g) / 100).toFixed(2),
    amount_source: grantAmountIsEstimated(g) ? "plan list price (not recorded)" : "razorpay captured",
    coupon_code: g.coupon_code || "",
    discount_percent: grantDiscountPercent(g) || "",
    discount_inr: (grantDiscountPaise(g) / 100).toFixed(2),
    premium_until: g.expires_at,
    days_left: premiumTimeLeft(g.expires_at).days,
  })));
}
