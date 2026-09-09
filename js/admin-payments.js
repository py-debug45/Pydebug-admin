// admin-payments.js — revenue overview + full payment log.
//
// Defensive by design: column names are auto-detected from the first row, so
// small schema differences in the user panel won't break this page.

let allPayments = [];
let filteredPayments = [];
let payUserMap = {};
let payCols = { amount: "amount_paise", plan: "plan", status: "status", txn: "razorpay_payment_id" };
let amountIsPaise = true;
const PAY_PAGE_SIZE = 100;
let payVisibleCount = PAY_PAGE_SIZE;

const PAY_SUCCESS = ["captured", "success", "succeeded", "paid", "completed", "authorized"];

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  await loadPayments();

  document.getElementById("payment-search").addEventListener("input", debounce(applyPaymentFilters, 300));
  document.getElementById("payment-filter-status").addEventListener("change", applyPaymentFilters);
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

async function loadPayments() {
  const tbody = document.getElementById("payments-tbody");
  tbody.innerHTML = `<tr><td colspan="6" class="empty-row">Loading payments...</td></tr>`;

  const { data, error } = await sb
    .from("payments")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">Could not load payments.</td></tr>`;
    document.getElementById("payments-hint").innerHTML =
      `<div class="admin-hint">Couldn't read the <code>payments</code> table (${escapeHtml(error.message)}). ` +
      `Run <code>supabase-admin-setup.sql</code> in Supabase → SQL Editor so admins can read all payments, then reload.</div>`;
    return;
  }

  allPayments = data || [];

  // Auto-detect column names from the first row.
  const sample = allPayments[0];
  payCols = {
    amount: detectCol(sample, ["amount_paise", "amount", "price_paise", "price"]),
    plan: detectCol(sample, ["plan", "plan_name", "plan_id", "description"]),
    status: detectCol(sample, ["status", "state"]),
    txn: detectCol(sample, ["razorpay_payment_id", "payment_id", "transaction_id", "txn_id", "order_id"]),
  };
  amountIsPaise = /paise/i.test(payCols.amount);

  const userIds = [...new Set(allPayments.map((p) => p.user_id).filter(Boolean))];
  if (userIds.length) {
    const { data: users } = await sb.from("profiles").select("id, full_name, email").in("id", userIds);
    (users || []).forEach((u) => { payUserMap[u.id] = u; });
  }

  buildStatusOptions();
  renderPaymentStats();
  applyPaymentFilters();
}

function paymentAmountPaise(p) {
  const raw = Number(p[payCols.amount]) || 0;
  return amountIsPaise ? raw : raw * 100;
}

function isSuccessfulPayment(p) {
  // No status column (or empty status) → treat every logged row as revenue,
  // same as the dashboard's historical behaviour.
  if (!p[payCols.status]) return true;
  return PAY_SUCCESS.includes(String(p[payCols.status]).toLowerCase());
}

function buildStatusOptions() {
  const sel = document.getElementById("payment-filter-status");
  const statuses = [...new Set(allPayments.map((p) => p[payCols.status]).filter(Boolean))].sort();
  statuses.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  });
}

function renderPaymentStats() {
  const ok = allPayments.filter(isSuccessfulPayment);
  const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const monthOk = ok.filter((p) => new Date(p.created_at).getTime() >= monthAgo);
  const total = ok.reduce((sum, p) => sum + paymentAmountPaise(p), 0);
  const monthTotal = monthOk.reduce((sum, p) => sum + paymentAmountPaise(p), 0);

  document.getElementById("pay-total-revenue").textContent = fmtINR(total / 100);
  document.getElementById("pay-month-revenue").textContent = fmtINR(monthTotal / 100);
  document.getElementById("pay-count").textContent = ok.length >= 1000 ? "1000+" : ok.length;
  document.getElementById("pay-avg").textContent = ok.length ? fmtINR(total / ok.length / 100) : fmtINR(0);
}

function applyPaymentFilters() {
  const search = document.getElementById("payment-search").value.trim().toLowerCase();
  const status = document.getElementById("payment-filter-status").value;

  filteredPayments = allPayments.filter((p) => {
    if (status !== "all" && String(p[payCols.status]) !== status) return false;
    if (search) {
      const u = payUserMap[p.user_id] || {};
      const hay = `${u.email || ""} ${u.full_name || ""} ${p[payCols.txn] || ""} ${p.id}`.toLowerCase();
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

  if (!filteredPayments.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No payments found.</td></tr>`;
    document.getElementById("payments-load-more").style.display = "none";
    return;
  }

  filteredPayments.slice(0, payVisibleCount).forEach((p) => {
    const u = payUserMap[p.user_id] || {};
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="muted" title="${escapeHtml(fmtDateTime(p.created_at))}">${escapeHtml(timeAgo(p.created_at))}</td>
      <td>${escapeHtml(u.email || u.full_name || "—")}</td>
      <td><strong>${escapeHtml(fmtINR(paymentAmountPaise(p) / 100))}</strong></td>
      <td>${escapeHtml(p[payCols.plan] || "—")}</td>
      <td>${statusBadge(p[payCols.status])}</td>
      <td class="mono muted">${escapeHtml(p[payCols.txn] || String(p.id).slice(0, 8))}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("payments-load-more").style.display =
    filteredPayments.length > payVisibleCount ? "" : "none";
}

function exportPayments() {
  const rows = filteredPayments.map((p) => ({
    id: p.id,
    date: p.created_at,
    user: (payUserMap[p.user_id] || {}).email || p.user_id,
    amount_inr: (paymentAmountPaise(p) / 100).toFixed(2),
    plan: p[payCols.plan] || "",
    status: p[payCols.status] || "",
    transaction: p[payCols.txn] || "",
  }));
  downloadCSV("pydebug-payments.csv", rows);
}
