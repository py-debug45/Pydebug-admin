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

  allOrders = ordersRes.status === "fulfilled"
    ? ordersRes.value.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    : [];
  allEntitlements = entRes.status === "fulfilled"
    ? entRes.value.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
    : [];

  const orderAmountById = {};
  allOrders.forEach((o) => {
    if (o.order_id && Number.isFinite(Number(o.amount))) {
      orderAmountById[o.order_id] = Number(o.amount);
    }
  });

  allGrants = (grantsRes.value || [])
    .map((g) => ({
      ...g,
      order_amount_paise: orderAmountById[g.order_id] ?? null,
    }))
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

  const paidOrderIds = new Set(allGrants.map((g) => g.order_id).filter(Boolean));
  const convertedOrders = allOrders.filter((o) => paidOrderIds.has(o.order_id)).length;
  const abandonedOrders = Math.max(0, allOrders.length - convertedOrders);
  const convPct = allOrders.length ? Math.round((convertedOrders / allOrders.length) * 100) + "% order conversion" : "no checkout orders yet";

  document.getElementById("pay-total-revenue").textContent = fmtINR(total / 100);
  document.getElementById("pay-month-revenue").textContent = fmtINR(monthTotal / 100);
  document.getElementById("pay-count").textContent = allGrants.length.toLocaleString("en-IN");
  document.getElementById("pay-orders-dropoff").textContent = abandonedOrders.toLocaleString("en-IN");
  document.getElementById("pay-conversion-rate").textContent = convPct;
  document.getElementById("pay-avg").textContent = allGrants.length ? fmtINR(total / allGrants.length / 100) : fmtINR(0);
}

function renderPlanCharts() {
  const byPlan = {};
  allGrants.forEach((g) => {
    const k = g.plan_key || "unknown";
    byPlan[k] = byPlan[k] || { count: 0, revenue: 0 };
    byPlan[k].count++;
    byPlan[k].revenue += grantAmountPaise(g);
  });
  const colors = [CHART_COLORS.mint, CHART_COLORS.amber, CHART_COLORS.purple, CHART_COLORS.blue];
  const keys = Object.keys(byPlan);
  document.getElementById("chart-plan-revenue").innerHTML = keys.length
    ? svgDonut(keys.map((k, i) => ({
        label: `${planLabel(k)} (₹${Math.round(byPlan[k].revenue / 100).toLocaleString("en-IN")})`,
        value: byPlan[k].revenue,
        color: colors[i % colors.length],
      })))
    : `<div class="chart-empty">No payments yet</div>`;
  document.getElementById("chart-plan-count").innerHTML = keys.length
    ? svgDonut(keys.map((k, i) => ({ label: planLabel(k), value: byPlan[k].count, color: colors[i % colors.length] })))
    : `<div class="chart-empty">No payments yet</div>`;
}

function applyPaymentFilters() {
  const search = document.getElementById("payment-search").value.trim().toLowerCase();
  const plan = document.getElementById("payment-filter-plan").value;

  filteredGrants = allGrants.filter((g) => {
    if (plan !== "all" && g.plan_key !== plan && g.product_key !== plan) return false;
    if (search) {
      const u = payUserMap[g.user_id] || {};
      const hay = `${u.email || ""} ${u.display_name || ""} ${u.full_name || ""} ${g.payment_id || ""} ${g.order_id || ""}`.toLowerCase();
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
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No payments found.</td></tr>`;
    document.getElementById("payments-load-more").style.display = "none";
    return;
  }

  tbody.innerHTML = filteredGrants.slice(0, payVisibleCount).map((g) => {
    const u = payUserMap[g.user_id] || {};
    const expired = g.expires_at && new Date(g.expires_at) < new Date();
    return `<tr>
      <td class="muted" title="${escapeHtml(fmtDateTime(g.created_at))}">${escapeHtml(timeAgo(g.created_at))}</td>
      <td>
        <a href="user-detail.html?id=${encodeURIComponent(g.user_id || "")}">${escapeHtml(displayNameOf(u))}</a>
        <div class="muted" style="font-size:0.75rem">${escapeHtml(u.email || "")}</div>
      </td>
      <td><span class="tag tag--premium">${escapeHtml(planLabel(g.plan_key))}</span></td>
      <td><strong>${escapeHtml(fmtINR(grantAmountPaise(g) / 100))}</strong></td>
      <td class="muted" title="${escapeHtml(fmtDateTime(g.expires_at))}">${expired ? "Expired" : escapeHtml(fmtDateTime(g.expires_at))}</td>
      <td class="mono muted" title="Order: ${escapeHtml(g.order_id || "")}">${escapeHtml((g.payment_id || "").slice(0, 16))}</td>
    </tr>`;
  }).join("");

  document.getElementById("payments-load-more").style.display =
    filteredGrants.length > payVisibleCount ? "" : "none";
}

function applyOrderFilters() {
  const paidOrderIds = new Set(allGrants.map((g) => g.order_id).filter(Boolean));
  const search = document.getElementById("order-search").value.trim().toLowerCase();
  const state = document.getElementById("order-filter-state").value;

  filteredOrders = allOrders.filter((o) => {
    const isPaid = paidOrderIds.has(o.order_id);
    if (state === "abandoned" && isPaid) return false;
    if (state === "converted" && !isPaid) return false;
    if (search) {
      const u = payUserMap[o.user_id] || {};
      const hay = `${o.order_id || ""} ${u.email || ""} ${u.display_name || ""} ${u.full_name || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const tbody = document.getElementById("orders-tbody");
  if (!filteredOrders.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No checkout orders match your filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = filteredOrders.slice(0, 150).map((o) => {
    const u = payUserMap[o.user_id] || {};
    const isPaid = paidOrderIds.has(o.order_id);
    const amt = Number.isFinite(Number(o.amount)) ? fmtINR(Number(o.amount) / 100) : fmtINR(planAmountPaise(o.plan_key) / 100);
    return `<tr>
      <td class="muted" title="${escapeHtml(fmtDateTime(o.created_at))}">${escapeHtml(timeAgo(o.created_at))}</td>
      <td>
        <a href="user-detail.html?id=${encodeURIComponent(o.user_id || "")}">${escapeHtml(displayNameOf(u))}</a>
        <div class="muted" style="font-size:0.74rem">${escapeHtml(u.email || "")}</div>
      </td>
      <td><span class="tag tag--info">${escapeHtml(planLabel(o.plan_key))}</span></td>
      <td><strong>${escapeHtml(amt)}</strong></td>
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
  let userId = uuidRe.test(raw) ? raw : null;

  if (!userId) {
    const { data, error } = await sb.from("profiles").select("id").ilike("email", sanitizeIlike(raw)).maybeSingle();
    if (error || !data) {
      showToast("No learner found with that email or UUID", "error");
      return;
    }
    userId = data.id;
  }

  const expires = new Date(Date.now() + days * 86400000).toISOString();
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
  showToast(`Granted ${product} for ${days} days`, "success");
  document.getElementById("ent-user").value = "";
  await loadAllPaymentData();
}

function exportPayments() {
  if (activePayTab === "orders") {
    const paidOrderIds = new Set(allGrants.map((g) => g.order_id).filter(Boolean));
    downloadCSV("pydebug-checkout-orders.csv", filteredOrders.map((o) => ({
      order_id: o.order_id,
      created_at: o.created_at,
      user: (payUserMap[o.user_id] || {}).email || o.user_id,
      plan: o.plan_key,
      amount_inr: ((Number(o.amount) || planAmountPaise(o.plan_key)) / 100).toFixed(2),
      status: paidOrderIds.has(o.order_id) ? "converted" : "abandoned",
    })));
    return;
  }
  downloadCSV("pydebug-payments.csv", filteredGrants.map((g) => ({
    payment_id: g.payment_id,
    order_id: g.order_id,
    date: g.created_at,
    user: (payUserMap[g.user_id] || {}).email || g.user_id,
    plan: g.plan_key,
    amount_inr: (grantAmountPaise(g) / 100).toFixed(2),
    premium_until: g.expires_at,
  })));
}
