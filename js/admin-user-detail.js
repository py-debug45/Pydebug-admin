// admin-user-detail.js — single-user overview + management actions.

// Badge catalogue — mirrors the user panel's js/achievements.js.
// (Unlocks are computed server-side; the admin panel only displays them.)
const PYDEBUG_BADGES = [
  { id: "first-blood", emoji: "🩸", title: "First Blood" },
  { id: "getting-started", emoji: "🌱", title: "Getting Started" },
  { id: "half-century", emoji: "🎯", title: "Half Century" },
  { id: "century-club", emoji: "💯", title: "Century Club" },
  { id: "week-warrior", emoji: "🔥", title: "Week Warrior" },
  { id: "consistency-king", emoji: "👑", title: "Consistency King" },
  { id: "bug-hunter", emoji: "🐛", title: "Bug Hunter" },
  { id: "fortune-teller", emoji: "🔮", title: "Fortune Teller" },
  { id: "topic-master-loops", emoji: "🏅", title: "Topic Master: Loops" },
  { id: "topic-master-strings", emoji: "🏅", title: "Topic Master: Strings" },
  { id: "topic-master-lists", emoji: "🏅", title: "Topic Master: Lists" },
  { id: "topic-master-dictionaries", emoji: "🏅", title: "Topic Master: Dictionaries" },
  { id: "topic-master-functions", emoji: "🏅", title: "Topic Master: Functions" },
  { id: "topic-master-oop", emoji: "🏅", title: "Topic Master: OOP" },
  { id: "topic-master-recursion", emoji: "🏅", title: "Topic Master: Recursion" },
  { id: "topic-master-exceptions", emoji: "🏅", title: "Topic Master: Exceptions" },
  { id: "topic-master-sets", emoji: "🏅", title: "Topic Master: Sets" },
  { id: "topic-master-sorting", emoji: "🏅", title: "Topic Master: Sorting" },
  { id: "topic-master-generators", emoji: "🏅", title: "Topic Master: Generators" },
  { id: "topic-master-tuples", emoji: "🏅", title: "Topic Master: Tuples" },
];

let currentAdmin = null;
let detailUserId = null;
let detailProfile = null;

document.addEventListener("DOMContentLoaded", async () => {
  currentAdmin = await requireAdmin();
  if (!currentAdmin) return;

  detailUserId = qs("id");
  if (!detailUserId) {
    showToast("No user id given", "error");
    setTimeout(() => (window.location.href = "users.html"), 1000);
    return;
  }

  await reloadUser();

  document.getElementById("xp-add-btn").addEventListener("click", addXp);
  document.getElementById("xp-set-btn").addEventListener("click", setXp);
  document.getElementById("freeze-add-btn").addEventListener("click", () => adjustFreezes(1));
  document.getElementById("freeze-remove-btn").addEventListener("click", () => adjustFreezes(-1));
  document.getElementById("display-name-save-btn").addEventListener("click", saveDisplayName);
  document.getElementById("premium-grant-btn").addEventListener("click", grantPremium);
  document.getElementById("premium-revoke-btn").addEventListener("click", revokePremium);
  document.getElementById("admin-toggle-btn").addEventListener("click", toggleAdmin);
  document.getElementById("reset-progress-btn").addEventListener("click", resetProgress);
});

async function reloadUser() {
  const { data, error } = await sb.from("profiles").select("*").eq("id", detailUserId).single();
  if (error || !data) {
    showToast("User not found", "error");
    setTimeout(() => (window.location.href = "users.html"), 1200);
    return;
  }
  detailProfile = data;
  renderProfile();
  await Promise.all([renderUserSubmissions(), renderBadges()]);
}

function renderProfile() {
  const p = detailProfile;
  const name = p.display_name || p.full_name || p.email || "User";
  document.getElementById("detail-avatar").textContent = name.trim().charAt(0).toUpperCase();
  document.getElementById("detail-name").textContent = name;
  document.getElementById("detail-email").textContent =
    (p.email || "") + (p.display_name && p.full_name && p.display_name !== p.full_name ? ` · ${p.full_name}` : "");
  document.getElementById("detail-joined").textContent = "Joined " + fmtDateTime(p.created_at);

  const premium = isPremiumUser(p);
  document.getElementById("detail-badges").innerHTML =
    (premium ? '<span class="tag tag--premium">Premium</span>' : '<span class="tag tag--free">Free</span>') +
    (p.is_admin ? ' <span class="tag tag--info">Admin</span>' : "");

  document.getElementById("detail-xp").textContent = (p.xp ?? 0).toLocaleString("en-IN");
  document.getElementById("detail-monthly-xp").textContent = (p.monthly_xp ?? 0).toLocaleString("en-IN");
  document.getElementById("detail-streak").textContent = p.streak ?? 0;
  document.getElementById("detail-last-active").textContent = p.last_active_date ? `last active ${p.last_active_date}` : "";
  document.getElementById("detail-freezes").textContent = p.streak_freezes ?? 0;
  document.getElementById("display-name-input").value = p.display_name || "";

  const cur = document.getElementById("premium-current");
  if (premium) {
    cur.textContent = p.premium_expires_at
      ? "Active until " + fmtDateTime(p.premium_expires_at)
      : "Active (lifetime / manual grant)";
  } else {
    cur.textContent = "No active premium.";
  }

  const toggleBtn = document.getElementById("admin-toggle-btn");
  toggleBtn.textContent = p.is_admin ? "Remove admin" : "Make admin";
  toggleBtn.disabled = p.is_admin && p.id === currentAdmin.id;
  toggleBtn.title = toggleBtn.disabled ? "You can't remove your own admin access" : "";
}

async function renderBadges() {
  const grid = document.getElementById("detail-badges-grid");
  const { data, error } = await sb.from("user_achievements").select("achievement_id, unlocked_at").eq("user_id", detailUserId);
  if (error) {
    grid.innerHTML = `<div class="chart-empty">Couldn't load badges (${escapeHtml(error.message)}). Run <code>supabase-admin-setup.sql</code>, then reload.</div>`;
    return;
  }
  const unlocked = {};
  (data || []).forEach((r) => { unlocked[r.achievement_id] = r.unlocked_at; });
  document.getElementById("detail-badge-count").textContent = `${Object.keys(unlocked).length}/${PYDEBUG_BADGES.length}`;
  grid.innerHTML = PYDEBUG_BADGES.map((b) => {
    const has = !!unlocked[b.id];
    return `<div class="badge-chip ${has ? "badge-chip--on" : ""}" title="${escapeHtml(b.title)}${has ? " — unlocked " + escapeHtml(fmtDateTime(unlocked[b.id])) : " — locked"}">
      <span class="badge-chip__emoji">${b.emoji}</span>
      <span class="badge-chip__title">${escapeHtml(b.title)}</span>
    </div>`;
  }).join("");
}

async function renderUserSubmissions() {
  const tbody = document.getElementById("detail-submissions-tbody");
  tbody.innerHTML = `<tr><td colspan="4" class="empty-row">Loading...</td></tr>`;

  const { data, error } = await sb
    .from("submissions")
    .select("*")
    .eq("user_id", detailUserId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-row">Couldn't load submissions (${escapeHtml(error.message)}). Run <code>supabase-admin-setup.sql</code>, then reload.</td></tr>`;
    return;
  }

  const rows = data || [];
  document.getElementById("detail-submissions").textContent = rows.length >= 20 ? "20+" : rows.length;
  document.getElementById("detail-sub-count").textContent = rows.length >= 20 ? "latest 20" : `${rows.length}`;
  document.getElementById("detail-solved").textContent = rows.filter((s) => s.status === "solved").length;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-row">No submissions yet.</td></tr>`;
    return;
  }

  const problemIds = [...new Set(rows.map((s) => s.problem_id).filter(Boolean))];
  let titles = {};
  if (problemIds.length) {
    const { data: problems } = await sb.from("problems").select("id, title").in("id", problemIds);
    (problems || []).forEach((p) => { titles[p.id] = p.title; });
  }

  tbody.innerHTML = "";
  rows.forEach((s) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="muted" title="${escapeHtml(fmtDateTime(s.created_at))}">${escapeHtml(timeAgo(s.created_at))}</td>
      <td>${escapeHtml(titles[s.problem_id] || "—")}</td>
      <td>${statusBadge(s.status || "attempted")}</td>
      <td class="muted" title="${escapeHtml(fmtDateTime(s.solved_at))}">${s.solved_at ? escapeHtml(timeAgo(s.solved_at)) : "—"}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function updateProfile(updates, successMsg, btn) {
  if (btn) btn.disabled = true;
  const { error } = await sb.from("profiles").update(updates).eq("id", detailUserId);
  if (btn) btn.disabled = false;
  if (error) {
    showToast("Could not update: " + error.message, "error");
    return false;
  }
  showToast(successMsg, "success");
  await reloadUser();
  return true;
}

async function addXp(e) {
  const delta = parseInt(document.getElementById("xp-amount").value, 10);
  if (isNaN(delta) || delta === 0) {
    showToast("Enter an XP amount first", "error");
    return;
  }
  // Mirror a real solve: both leaderboards move together.
  await updateProfile(
    { xp: (detailProfile.xp ?? 0) + delta, monthly_xp: (detailProfile.monthly_xp ?? 0) + delta },
    `XP updated (${delta > 0 ? "+" : ""}${delta} total + monthly)`,
    e.target
  );
}

async function setXp(e) {
  const val = parseInt(document.getElementById("xp-amount").value, 10);
  if (isNaN(val) || val < 0) {
    showToast("Enter a valid XP value (0 or more)", "error");
    return;
  }
  await updateProfile({ xp: val }, `Total XP set to ${val}`, e.target);
}

async function adjustFreezes(delta) {
  const next = Math.max(0, (detailProfile.streak_freezes ?? 0) + delta);
  await updateProfile({ streak_freezes: next }, `Streak freezes: ${next}`, null);
}

async function saveDisplayName(e) {
  const val = document.getElementById("display-name-input").value.trim().slice(0, 60);
  await updateProfile({ display_name: val || null }, val ? "Display name saved" : "Display name cleared (fallback active)", e.target);
}

function expiryForDuration(d) {
  if (d === "lifetime") return null;
  const dt = new Date();
  if (d === "1mo") dt.setMonth(dt.getMonth() + 1);
  if (d === "3mo") dt.setMonth(dt.getMonth() + 3);
  if (d === "1yr") dt.setFullYear(dt.getFullYear() + 1);
  return dt.toISOString();
}

async function grantPremium(e) {
  const duration = document.getElementById("premium-duration").value;
  await updateProfile(
    { is_premium: true, premium_expires_at: expiryForDuration(duration) },
    "Premium granted",
    e.target
  );
}

async function revokePremium(e) {
  await updateProfile({ is_premium: false, premium_expires_at: null }, "Premium revoked", e.target);
}

async function toggleAdmin(e) {
  const making = !detailProfile.is_admin;
  if (!making && detailProfile.id === currentAdmin.id) {
    showToast("You can't remove your own admin access", "error");
    return;
  }
  if (!confirm(making ? "Make this user an admin? They'll be able to log into this panel." : "Remove admin access from this user?")) return;
  await updateProfile({ is_admin: making }, making ? "User is now an admin" : "Admin access removed", e.target);
}

async function resetProgress(e) {
  if (!confirm("Reset this user's total + monthly XP and streak to 0? Submissions and badges will be kept.")) return;
  await updateProfile({ xp: 0, monthly_xp: 0, streak: 0 }, "Progress reset", e.target);
}
