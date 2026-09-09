// admin-common.js — shared across every admin page
// Relies on ../js/supabaseClient.js and ../js/utils.js being loaded first
// (same Supabase project as the user panel, so `sb` is already available).

// Redirects to admin login unless the logged-in user has is_admin = true on
// their profiles row. This is a UX gate only — the real security boundary is
// the Supabase RLS policies (is_admin() function) that block writes at the
// database level even if someone bypasses this check.
async function requireAdmin() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = "index.html";
    return null;
  }

  const { data: profile, error } = await sb
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .single();

  if (error || !profile || !profile.is_admin) {
    await sb.auth.signOut();
    window.location.href = "index.html?denied=1";
    return null;
  }

  const nameEl = document.getElementById("admin-name");
  if (nameEl) nameEl.textContent = profile.full_name || profile.email;

  return profile;
}

async function logoutAdmin() {
  await sb.auth.signOut();
  window.location.href = "index.html";
}

// "5m ago" style relative time for activity feeds and tables.
function timeAgo(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "—";
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d < 30) return d + "d ago";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Rupees → "₹1,234" (callers pass rupees; divide paise by 100 first)
function fmtINR(rupees) {
  return "₹" + Math.round(rupees || 0).toLocaleString("en-IN");
}

// Coloured badge for submission / payment statuses (tolerates unknown values).
function statusBadge(status) {
  const s = String(status || "").toLowerCase();
  let cls = "tag--unknown";
  if (["solved", "success", "succeeded", "captured", "paid", "completed"].includes(s)) cls = "tag--solved";
  else if (["attempted", "pending", "created", "authorized"].includes(s)) cls = "tag--attempted";
  else if (["failed", "error", "cancelled", "canceled", "refunded"].includes(s)) cls = "tag--failed";
  return `<span class="tag ${cls}">${escapeHtml(status || "—")}</span>`;
}

// Premium plans — MUST stay in sync with the user panel's api/_plans.js
// (amount in paise). Used to derive revenue from the payment_grants ledger.
const PYDEBUG_PLANS = {
  monthly: { label: "Monthly Premium", amount: 9900, days: 30 },
  sixmonth: { label: "6-Month Premium", amount: 49900, days: 182 },
  yearly: { label: "Yearly Premium", amount: 79900, days: 365 },
};

function planLabel(key) {
  return (PYDEBUG_PLANS[key] && PYDEBUG_PLANS[key].label) || key || "—";
}

function planAmountPaise(key) {
  return (PYDEBUG_PLANS[key] && PYDEBUG_PLANS[key].amount) || 0;
}

// Pick the first key from `candidates` that exists on the sample row.
// Lets admin pages survive small schema differences in the user panel.
function detectCol(sample, candidates) {
  if (!sample) return candidates[0];
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(sample, c)) return c;
  }
  return candidates[0];
}

function markAdminActiveNav() {
  const page = window.location.pathname.split("/").pop() || "dashboard.html";
  document.querySelectorAll("[data-admin-nav]").forEach((link) => {
    if (link.getAttribute("data-admin-nav") === page) link.classList.add("active");
  });
}

document.addEventListener("DOMContentLoaded", () => {
  markAdminActiveNav();
  document.querySelectorAll("[data-admin-logout]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      logoutAdmin();
    })
  );
});
