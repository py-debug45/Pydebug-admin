// admin-payments.js — revenue overview + verified payment log.
//
// Source of truth is `payment_grants`: the user app's verify-payment API
// writes exactly one row per verified Razorpay payment (idempotent), so
// every row here is real revenue. Amounts come from PYDEBUG_PLANS
// (keep in sync with the user panel's api/_plans.js).

let allGrants = [];
let filteredGrants = [];
let payUserMap = {};
const PAY_PAGE_SIZE = 100;
let payVisibleCount = PAY_PAGE_SIZE;

onAdminReady(async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  await loadGrants();

  document.getElementById("payment-search").addEventListener("input", debounce(applyPaymentFilters, 300));
  document.getElementById("payment-filter-plan").addEventListener("change", applyPaymentFilters);
  document.getElementById("payments-load-more").addEventListener("click", () => {
    payVisibleCount += PAY_PAGE_SIZE;
    renderPayments();
  });
  document.getElementById("export-payments-btn").addEventListener("click", exportPayments);
});

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function displayNameOf(u) {
  return u.display_name || u.full_name || u.email || "—";
}

async function loadGrants() {
  const tbody = document.getElementById("payments-tbody");
  tbody.innerHTML = `<tr><td colspan="6" class="empty-row">Loading payments...</td></tr>`;

  // Ask only for the columns this page reads. Older databases may not have
  // every column, so fall back to "*" when Postgres says "undefined column".
  const GRANT_COLS = "id, user_id, plan_key, order_id, payment_id, amount_inr, created_at, expires_at";
  const query = (cols) =>
    sb.from("payment_grants").select(cols).order("created_at", { ascending: false }).limit(1000);

  let { data, error } = await query(GRANT_COLS);
  if (error && (error.code === "42703" || /column .* does not exist/i.test(error.message || ""))) {
    ({ data, error } = await query("*"));
  }

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">Could not load payments.</td></tr>`;
    document.getElementById("payments-hint").innerHTML =
      `<div class="admin-hint">Couldn't read the <code>payment_grants</code> table (${escapeHtml(error.message)}). ` +
      `Run <code>supabase-admin-setup.sql</code> in Supabase → SQL Editor so admins can read all payments, then reload.</div>`;
    document.getElementById("chart-plan-revenue").innerHTML = `<div class="chart-empty">Unavailable</div>`;
    document.getElementById("chart-plan-count").innerHTML = `<div class="chart-empty">Unavailable</div>`;
    return;
  }

  allGrants = data || [];

  const userIds = [...new Set(allGrants.map((g) => g.user_id).filter(Boolean))];
  if (userIds.length) {
    const { data: users } = await sb.from("profiles").select("id, display_name, full_name, email").in("id", userIds);
    (users || []).forEach((u) => { payUserMap[u.id] = u; });
  }

  renderPaymentStats();
  renderPlanCharts();
  applyPaymentFilters();
}

function renderPaymentStats() {
  const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const total = allGrants.reduce((s, g) => s + planAmountPaise(g.plan_key), 0);
  const monthTotal = allGrants
    .filter((g) => new Date(g.created_at).getTime() >= monthAgo)
    .reduce((s, g) => s + planAmountPaise(g.plan_key), 0);

  document.getElementById("pay-total-revenue").textContent = fmtINR(total / 100);
  document.getElementById("pay-month-revenue").textContent = fmtINR(monthTotal / 100);
  document.getElementById("pay-count").textContent = allGrants.length >= 1000 ? "1000+" : allGrants.length;
  document.getElementById("pay-avg").textContent = allGrants.length ? fmtINR(total / allGrants.length / 100) : fmtINR(0);
}

function renderPlanCharts() {
  const byPlan = {};
  allGrants.forEach((g) => {
    const k = g.plan_key || "unknown";
    byPlan[k] = byPlan[k] || { count: 0, revenue: 0 };
    byPlan[k].count++;
    byPlan[k].revenue += planAmountPaise(g.plan_key);
  });
  const colors = [CHART_COLORS.mint, CHART_COLORS.amber, CHART_COLORS.purple, CHART_COLORS.blue];
  const keys = Object.keys(byPlan);
  document.getElementById("chart-plan-revenue").innerHTML = svgDonut(
    keys.map((k, i) => ({ label: `${planLabel(k)} (₹${Math.round(byPlan[k].revenue / 100).toLocaleString("en-IN")})`, value: byPlan[k].revenue, color: colors[i % colors.length] }))
  );
  document.getElementById("chart-plan-count").innerHTML = svgDonut(
    keys.map((k, i) => ({ label: planLabel(k), value: byPlan[k].count, color: colors[i % colors.length] }))
  );
}

function applyPaymentFilters() {
  const search = document.getElementById("payment-search").value.trim().toLowerCase();
  const plan = document.getElementById("payment-filter-plan").value;

  filteredGrants = allGrants.filter((g) => {
    if (plan !== "all" && g.plan_key !== plan) return false;
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
      <td>${escapeHtml(displayNameOf(u))}<div class="muted" style="font-size:0.75rem">${escapeHtml(u.email || "")}</div></td>
      <td><span class="tag tag--premium">${escapeHtml(planLabel(g.plan_key))}</span></td>
      <td><strong>${escapeHtml(fmtINR(planAmountPaise(g.plan_key) / 100))}</strong></td>
      <td class="muted" title="${escapeHtml(fmtDateTime(g.expires_at))}">${expired ? "Expired" : escapeHtml(timeAgo(g.expires_at)).replace(" ago", " left")}</td>
      <td class="mono muted" title="Order: ${escapeHtml(g.order_id || "")}">${escapeHtml((g.payment_id || "").slice(0, 14))}</td>
    </tr>`;
  }).join("");

  document.getElementById("payments-load-more").style.display =
    filteredGrants.length > payVisibleCount ? "" : "none";
}

function exportPayments() {
  const rows = filteredGrants.map((g) => ({
    payment_id: g.payment_id,
    order_id: g.order_id,
    date: g.created_at,
    user: (payUserMap[g.user_id] || {}).email || g.user_id,
    plan: g.plan_key,
    amount_inr: (planAmountPaise(g.plan_key) / 100).toFixed(2),
    premium_until: g.expires_at,
  }));
  downloadCSV("pydebug-payments.csv", rows);
}
