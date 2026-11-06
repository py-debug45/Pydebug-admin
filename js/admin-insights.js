let insightRows = { profiles: [], submissions: [], problems: [], grants: [] };

onAdminReady(async () => {
  if (!(await requirePerm("dashboard.read"))) return;
  await loadInsights();
  document.getElementById("refresh-insights").onclick = loadInsights;
});

const esc = (x) => escapeHtml(String(x ?? ""));

async function loadInsights() {
  const b = document.getElementById("refresh-insights");
  b.disabled = true;
  b.textContent = "↻ Loading…";
  try {
    const [profiles, submissions, problems, grants, orders] = await Promise.all([
      fetchAdminRows("profiles", "id,email,display_name,xp,streak,is_premium,premium_expires_at,created_at"),
      fetchAdminRows("submissions", "id,user_id,problem_id,status,is_correct,created_at"),
      fetchAdminRows("problems", "id,title,difficulty,topic"),
      fetchAdminRows("payment_grants", "payment_id,user_id,order_id,plan_key,amount_paise,created_at", "payment_id").catch(() => []),
      fetchAdminRows("payment_orders", "order_id,amount", "created_at").catch(() => []),
    ]);
    const orderMap = {};
    (orders || []).forEach((o) => {
      if (o.order_id && Number.isFinite(Number(o.amount))) orderMap[o.order_id] = Number(o.amount);
    });
    const enrichedGrants = (grants || []).map((g) => ({ ...g, order_amount_paise: orderMap[g.order_id] ?? null }));
    insightRows = { profiles, submissions, problems, grants: enrichedGrants };
    renderInsights();
    showToast("Insights refreshed", "success");
  } catch (e) {
    showToast("Could not load insights: " + e.message, "error");
  } finally {
    b.disabled = false;
    b.textContent = "↻ Refresh";
  }
}

function renderInsights() {
  const { profiles, submissions, problems, grants } = insightRows;
  const active = new Set(submissions.map((x) => x.user_id).filter(Boolean));
  const solved = new Set(
    submissions
      .filter((x) => x.is_correct === true || ["solved", "success", "correct", "passed"].includes(String(x.status || "").toLowerCase()))
      .map((x) => x.user_id)
      .filter(Boolean)
  );
  const premium = profiles.filter(isPremiumUser);

  document.getElementById("f-signups").textContent = profiles.length.toLocaleString("en-IN");
  document.getElementById("f-started").textContent = active.size.toLocaleString("en-IN");
  document.getElementById("f-solved").textContent = solved.size.toLocaleString("en-IN");
  document.getElementById("f-premium").textContent = premium.length.toLocaleString("en-IN");
  document.getElementById("f-conversion").textContent = profiles.length
    ? Math.round((premium.length / profiles.length) * 100) + "%"
    : "—";

  const sachetRoot = document.getElementById("insights-sachet-root");
  if (sachetRoot) sachetRoot.innerHTML = renderSachetCardHtml(computeSachetMetrics(grants));

  const campusRoot = document.getElementById("insights-campus-root");
  if (campusRoot) campusRoot.innerHTML = renderCampusAnalyticsHtml(aggregateCampuses(profiles), { limit: 20, allowFilter: false });

  const pct = (n) => (profiles.length ? Math.round((n / profiles.length) * 100) : 0);
  document.getElementById("funnel").innerHTML = [
    ["Registered", profiles.length, 100],
    ["Started practicing", active.size, pct(active.size)],
    ["Solved a problem", solved.size, pct(solved.size)],
    ["Premium", premium.length, pct(premium.length)],
  ]
    .map((x) => `<div class="insight-row"><span>${x[0]}</span><strong>${x[1].toLocaleString("en-IN")}</strong><em>${x[2]}%</em><i style="width:${x[2]}%"></i></div>`)
    .join("");

  const now = Date.now(), week = now + 7 * 864e5;
  const exp = premium
    .filter((u) => u.premium_expires_at && new Date(u.premium_expires_at).getTime() <= week)
    .sort((a, b) => new Date(a.premium_expires_at) - new Date(b.premium_expires_at));
  document.getElementById("expiring").innerHTML = exp.length
    ? exp
        .slice(0, 20)
        .map((u) => `<div class="insight-item"><span>${esc(u.display_name || u.email || "User")}</span><strong>${Math.max(0, Math.ceil((new Date(u.premium_expires_at) - now) / 864e5))}d left</strong><a href="user-detail.html?id=${encodeURIComponent(u.id)}">Manage</a></div>`)
        .join("")
    : '<div class="empty-row">No plans expiring in 7 days.</div>';

  const cutoff = new Date(now - 7 * 864e5);
  const recent = new Set(submissions.filter((x) => new Date(x.created_at) >= cutoff).map((x) => x.user_id));
  const inactive = profiles.filter((u) => !recent.has(u.id)).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  document.getElementById("inactive").innerHTML = inactive.length
    ? inactive
        .slice(0, 20)
        .map((u) => `<div class="insight-item"><span>${esc(u.display_name || u.email || "User")}</span><small>joined ${esc(timeAgo(u.created_at))}</small><a href="user-detail.html?id=${encodeURIComponent(u.id)}">View</a></div>`)
        .join("")
    : '<div class="empty-row">Everyone has practiced this week 🎉</div>';

  const pm = new Map(problems.map((p) => [p.id, { ...p, attempts: 0, solved: 0 }]));
  submissions.forEach((s) => {
    const p = pm.get(s.problem_id);
    if (p) {
      p.attempts++;
      if (s.is_correct === true || ["solved", "success", "correct", "passed"].includes(String(s.status || "").toLowerCase())) {
        p.solved++;
      }
    }
  });
  const top = [...pm.values()].filter((p) => p.attempts).sort((a, b) => b.attempts - a.attempts).slice(0, 12);
  document.getElementById("problem-performance").innerHTML = top.length
    ? top
        .map((p) => `<div class="insight-item"><span>${esc(p.title)}</span><small>${p.attempts} attempts · ${Math.round((p.solved / p.attempts) * 100)}% solved</small><a href="problem-form.html?id=${encodeURIComponent(p.id)}">Edit</a></div>`)
        .join("")
    : '<div class="empty-row">No submissions yet.</div>';
}
