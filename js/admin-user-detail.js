// admin-user-detail.js — single-user overview + management + account moderation + certificates/mocks.

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

onAdminReady(async () => {
  currentAdmin = await requireAdmin();
  if (!currentAdmin) return;

  detailUserId = qs("id");
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!detailUserId || !UUID_RE.test(detailUserId)) {
    showToast("No valid user id given", "error");
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
  document.getElementById("mod-save-btn").addEventListener("click", saveModeration);
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
  await Promise.all([renderUserSubmissions(), renderBadges(), renderCertsAndMocks(), renderPurchases()]);
}

// Every Razorpay purchase this learner ever made: what they actually paid,
// the list price, the coupon/discount, when they bought it and when premium
// access runs out (payment_grants is the permanent ledger).
async function renderPurchases() {
  const tbody = document.getElementById("detail-purchases-tbody");
  const countEl = document.getElementById("detail-purchase-count");
  const spendEl = document.getElementById("detail-spend");
  const spendSub = document.getElementById("detail-spend-sub");
  if (!tbody) return;

  const { data, error } = await sb
    .from("payment_grants")
    .select("*")
    .eq("user_id", detailUserId)
    .order("created_at", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">Could not load purchases (${escapeHtml(error.message || "unavailable")}).</td></tr>`;
    if (countEl) countEl.textContent = "";
    return;
  }

  const rows = data || [];
  const total = rows.reduce((sum, g) => sum + grantAmountPaise(g), 0);
  if (spendEl) spendEl.textContent = fmtINR(total / 100);
  if (spendSub) {
    const estimated = rows.filter((g) => grantAmountIsEstimated(g)).length;
    spendSub.textContent = estimated
      ? `${estimated} legacy amount${estimated === 1 ? "" : "s"} not recorded`
      : "actually paid";
  }
  if (countEl) countEl.textContent = rows.length ? `${rows.length} payment${rows.length === 1 ? "" : "s"}` : "";

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No premium purchase yet — access may have been granted manually.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((g) => {
    const paid = grantPaidPaise(g);
    const pct = grantDiscountPercent(g);
    const list = grantListAmountPaise(g);
    const saved = grantDiscountPaise(g);
    const left = premiumTimeLeft(g.expires_at);
    const paidCell = paid === null
      ? `<strong title="The charged amount was not recorded for this legacy payment.">${escapeHtml(fmtINR(grantAmountPaise(g) / 100))}*</strong>`
      : `<strong>${escapeHtml(fmtINR(paid / 100))}</strong>`;
    return `<tr>
      <td title="${escapeHtml(fmtDateTime(g.created_at))}">
        ${escapeHtml(fmtDateTime(g.created_at))}
        <div class="muted" style="font-size:0.74rem">${escapeHtml(timeAgo(g.created_at))}</div>
      </td>
      <td><span class="tag tag--premium">${escapeHtml(planLabel(g.plan_key))}</span></td>
      <td>
        ${paidCell}
        <div class="muted" style="font-size:0.74rem">${pct > 0 ? `list ${escapeHtml(fmtINR(list / 100))}` : ""}</div>
      </td>
      <td>
        ${pct > 0
          ? `<span class="tag tag--solved">${pct}% off</span>
             <div class="muted" style="font-size:0.74rem">${escapeHtml(g.coupon_code || "coupon")}${saved ? ` · ${escapeHtml(fmtINR(saved / 100))} saved` : ""}</div>`
          : `<span class="muted">—</span>`}
      </td>
      <td>
        ${escapeHtml(fmtDateTime(g.expires_at))}
        <div class="muted" style="font-size:0.74rem">${escapeHtml(left.label)}</div>
      </td>
      <td class="mono muted" title="${escapeHtml(g.payment_id || "")}">${escapeHtml((g.payment_id || "—").slice(0, 18))}</td>
    </tr>`;
  }).join("");
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
    accountStatusBadge(p) + " " +
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

  const st = p.status || "active";
  document.getElementById("mod-status").value = ["active", "muted", "suspended", "banned"].includes(st) ? st : "active";
  document.getElementById("mod-reason").value = p.status_reason || "";
  const modCur = document.getElementById("moderation-current");
  if (st === "active") {
    modCur.textContent = "Account is active and in good standing.";
  } else {
    modCur.textContent = `Status: ${st.toUpperCase()}${p.status_until ? " until " + fmtDateTime(p.status_until) : " (indefinite)"}${p.status_reason ? " · " + p.status_reason : ""}`;
  }

  const toggleBtn = document.getElementById("admin-toggle-btn");
  toggleBtn.textContent = p.is_admin ? "Remove admin" : "Make admin";
  toggleBtn.disabled = p.is_admin && p.id === currentAdmin.id;
  toggleBtn.title = toggleBtn.disabled ? "You can't remove your own admin access" : "";
}

async function renderCertsAndMocks() {
  const card = document.getElementById("detail-certs-card");
  const [certRes, mockRes] = await Promise.all([
    sb.from("user_certificates").select("verify_id, tier_id, issued_at, revoked_at").eq("user_id", detailUserId).order("issued_at", { ascending: false }),
    sb.from("mock_attempts").select("paper_id, status, score, percentile, submitted_at, started_at").eq("user_id", detailUserId).order("started_at", { ascending: false }).limit(10),
  ]);

  const certs = certRes.data || [];
  const mocks = mockRes.data || [];
  document.getElementById("detail-cert-count").textContent = `${certs.length} certs · ${mocks.length} mocks`;

  const certHtml = certs.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">${certs.map((c) => `
        <a href="certificates.html" class="badge-chip badge-chip--on" style="text-decoration:none">
          ${tierBadge(c.tier_id)}
          <span class="mono" style="font-size:0.76rem">${escapeHtml(c.verify_id)}</span>
          ${c.revoked_at ? '<span class="tag tag--failed">Revoked</span>' : ""}
        </a>`).join("")}</div>`
    : `<div class="muted" style="font-size:0.84rem;margin-bottom:10px">No certificates issued yet.</div>`;

  const mockHtml = mocks.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:8px">${mocks.map((m) => `
        <span class="badge-chip">
          <strong>${escapeHtml(m.paper_id)}</strong>
          <span>${m.score != null ? Number(m.score) + "%" : escapeHtml(m.status || "started")}</span>
        </span>`).join("")}</div>`
    : `<div class="muted" style="font-size:0.84rem">No mock test attempts yet.</div>`;

  card.innerHTML = certHtml + mockHtml;
}

async function renderBadges() {
  const grid = document.getElementById("detail-badges-grid");
  const { data, error } = await sb.from("user_achievements").select("achievement_id, unlocked_at").eq("user_id", detailUserId);
  if (error) {
    grid.innerHTML = `<div class="chart-empty">Couldn't load badges (${escapeHtml(error.message)}).</div>`;
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
    tbody.innerHTML = `<tr><td colspan="4" class="empty-row">Couldn't load submissions (${escapeHtml(error.message)}).</td></tr>`;
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

  tbody.innerHTML = rows.map((s) => `<tr>
    <td class="muted" title="${escapeHtml(fmtDateTime(s.created_at))}">${escapeHtml(timeAgo(s.created_at))}</td>
    <td>${escapeHtml(titles[s.problem_id] || "—")}</td>
    <td>${statusBadge(s.status || "attempted")}</td>
    <td class="muted" title="${escapeHtml(fmtDateTime(s.solved_at))}">${s.solved_at ? escapeHtml(timeAgo(s.solved_at)) : "—"}</td>
  </tr>`).join("");
}

async function updateProfile(updates, successMsg, btn) {
  if (btn) btn.disabled = true;
  const { error } = await sb.rpc("admin_panel_update_profile", { target_user: detailUserId, patch: updates });
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

async function saveModeration(e) {
  const status = document.getElementById("mod-status").value;
  const dur = document.getElementById("mod-duration").value;
  const reason = document.getElementById("mod-reason").value.trim();

  if (status !== "active" && detailProfile.id === currentAdmin.id) {
    showToast("You cannot mute, suspend, or ban your own admin account", "error");
    return;
  }

  let until = null;
  if (status !== "active") {
    if (dur === "24h") until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    else if (dur === "7d") until = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
    else if (dur === "30d") until = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
  }

  await updateProfile(
    {
      status,
      status_until: status === "active" ? null : until,
      status_reason: status === "active" ? null : (reason || null),
    },
    `Account status set to ${status}`,
    e.target
  );
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
