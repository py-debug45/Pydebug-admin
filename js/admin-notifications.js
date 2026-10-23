// admin-notifications.js — in-app bell broadcast + Web Push announcements + DB bloat hygiene.

let currentNotifAdmin = null;

onAdminReady(async () => {
  currentNotifAdmin = await requireAdmin();
  if (!currentNotifAdmin) return;

  await refreshNotificationsPage();

  document.getElementById("broadcast-form").addEventListener("submit", sendBroadcast);
  document.getElementById("refresh-notif-btn").addEventListener("click", refreshNotificationsPage);
  document.getElementById("prune-7d-btn").addEventListener("click", () => pruneNotifications(7));
  document.getElementById("prune-keep3-btn").addEventListener("click", () => pruneNotifications(0));
});

async function refreshNotificationsPage() {
  await Promise.all([loadNotifKPIs(), loadRecent(), loadPushAnnouncements()]);
}

async function loadNotifKPIs() {
  try {
    const [totalRes, bloatRes, subRes, annRes] = await Promise.all([
      sb.from("notifications").select("*", { count: "exact", head: true }),
      sb.from("notifications").select("*", { count: "exact", head: true }).in("title", ["📝 New Problem Added!", "New Problem Added!"]),
      sb.from("push_subscriptions").select("*", { count: "exact", head: true }),
      sb.from("push_announcements").select("*", { count: "exact", head: true }),
    ]);
    document.getElementById("notif-db-total").textContent = totalRes.error ? "—" : (totalRes.count ?? 0).toLocaleString("en-IN");
    document.getElementById("notif-auto-bloat").textContent = bloatRes.error ? "—" : (bloatRes.count ?? 0).toLocaleString("en-IN");
    document.getElementById("push-sub-count").textContent = subRes.error ? "—" : (subRes.count ?? 0).toLocaleString("en-IN");
    document.getElementById("push-ann-count").textContent = annRes.error ? "—" : (annRes.count ?? 0).toLocaleString("en-IN");
  } catch (e) {
    console.warn("loadNotifKPIs:", e.message);
  }
}

async function loadPushAnnouncements() {
  const tbody = document.getElementById("push-ann-tbody");
  const { data, error } = await sb
    .from("push_announcements")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(25);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-row">Unavailable (${escapeHtml(error.message)})</td></tr>`;
    return;
  }

  const rows = data || [];
  document.getElementById("push-list-count").textContent = rows.length;
  tbody.innerHTML = rows.length
    ? rows.map((p) => `<tr>
        <td class="muted">${escapeHtml(timeAgo(p.created_at))}</td>
        <td><strong>${escapeHtml(p.title || "")}</strong><div class="muted" style="font-size:0.75rem">${escapeHtml((p.body || "").slice(0, 80))}</div></td>
        <td><span class="tag tag--info">${escapeHtml(p.segment || "all")}</span></td>
        <td class="mono muted">${escapeHtml(p.url || "/")}</td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="empty-row">No Web Push announcements recorded yet.</td></tr>`;
}

async function pruneNotifications(days) {
  const msg = days <= 0
    ? "Keep only the newest 3 automated alerts per learner and delete all older duplicate auto-notifications?"
    : `Delete automated notifications (new_problem / streak_warning / leaderboard_rank) older than ${days} days?`;
  if (!confirm(msg)) return;

  const btn = document.getElementById(days <= 0 ? "prune-keep3-btn" : "prune-7d-btn");
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Cleaning...";

  const { data: deleted, error } = await sb.rpc("admin_prune_notifications", {
    older_than_days: days,
    auto_only: true,
  });
  btn.disabled = false;
  btn.textContent = orig;

  if (error) {
    showToast("Prune failed: " + error.message, "error");
    return;
  }
  showToast(`Cleaned ${(Number(deleted) || 0).toLocaleString("en-IN")} bloated notifications`, "success");
  await refreshNotificationsPage();
}

async function loadRecent() {
  const tbody = document.getElementById("notifications-tbody");
  tbody.innerHTML = `<tr><td colspan="6" class="empty-row">Loading...</td></tr>`;

  const { data, error } = await sb
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">Could not load notifications.</td></tr>`;
    document.getElementById("notifications-hint").innerHTML =
      `<div class="admin-hint">Couldn't read <code>notifications</code> (${escapeHtml(error.message)}).</div>`;
    return;
  }

  const rows = data || [];
  document.getElementById("notif-count").textContent = rows.length >= 100 ? "latest 100" : `${rows.length}`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No notifications sent yet — use the form above.</td></tr>`;
    return;
  }

  const userIds = [...new Set(rows.map((n) => n.user_id).filter(Boolean))];
  const emailById = {};
  if (userIds.length) {
    const { data: users } = await sb.from("profiles").select("id, email").in("id", userIds);
    (users || []).forEach((u) => { emailById[u.id] = u.email; });
  }

  tbody.innerHTML = rows.map((n) => `<tr>
    <td class="muted" title="${escapeHtml(fmtDateTime(n.created_at))}">${escapeHtml(timeAgo(n.created_at))}</td>
    <td>${escapeHtml(emailById[n.user_id] || "—")}</td>
    <td>${escapeHtml(n.title || "")}</td>
    <td class="comment-excerpt" title="${escapeHtml(n.message || "")}">${escapeHtml(n.message || "")}</td>
    <td>${n.is_read ? '<span class="tag tag--unknown">Read</span>' : '<span class="tag tag--info">Unread</span>'}</td>
    <td class="row-actions">
      <button class="btn btn--danger btn--sm" data-del-notif="${escapeHtml(n.id)}">Delete</button>
    </td>
  </tr>`).join("");

  if (tbody.dataset.bound !== "1") {
    tbody.dataset.bound = "1";
    tbody.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-del-notif]");
      if (button) deleteNotification(button.dataset.delNotif, button);
    });
  }
}

async function deleteNotification(id, btn) {
  if (!confirm("Delete this notification?")) return;
  btn.disabled = true;
  const { error } = await sb.from("notifications").delete().eq("id", id);
  if (error) {
    showToast("Could not delete: " + error.message, "error");
    btn.disabled = false;
    return;
  }
  showToast("Notification deleted", "success");
  await refreshNotificationsPage();
}

async function sendBroadcast(e) {
  e.preventDefault();
  const title = document.getElementById("broadcast-title").value.trim();
  const message = document.getElementById("broadcast-message").value.trim();
  let link = document.getElementById("broadcast-link").value.trim();
  const type = document.getElementById("broadcast-type").value;
  const audience = document.getElementById("broadcast-audience").value;
  const alsoPush = document.getElementById("broadcast-also-push").checked;
  const btn = document.getElementById("broadcast-send-btn");
  const progress = document.getElementById("broadcast-progress");

  if (!title || !message) {
    showToast("Title and message are required", "error");
    return;
  }
  if (link && !link.startsWith("/")) {
    showToast("Link must be an in-app path starting with / (e.g. /problems)", "error");
    return;
  }
  if (link === "") link = null;

  btn.disabled = true;
  btn.textContent = "Sending...";
  progress.textContent = "Finding recipients...";

  try {
    let recipients = [];
    let from = 0;
    const PAGE = 1000;
    for (;;) {
      const { data, error } = await sb
        .from("profiles")
        .select("id, is_premium, premium_expires_at")
        .order("created_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      const rows = data || [];
      const ids = rows
        .filter((r) => {
          const active = isPremiumUser(r);
          if (audience === "premium") return active;
          if (audience === "free") return !active;
          return true;
        })
        .map((r) => r.id);
      recipients.push(...ids);
      if (rows.length < PAGE) break;
      from += PAGE;
    }

    if (!recipients.length) {
      showToast("No users match this audience", "error");
      progress.textContent = "";
      btn.disabled = false;
      btn.textContent = "Send broadcast";
      return;
    }

    if (!confirm(`Send "${title}" to ${recipients.length} user${recipients.length === 1 ? "" : "s"}${alsoPush ? " + Web Push queue" : ""}?`)) {
      progress.textContent = "";
      btn.disabled = false;
      btn.textContent = "Send broadcast";
      return;
    }

    const CHUNK = 200;
    let sent = 0;
    for (let i = 0; i < recipients.length; i += CHUNK) {
      const chunk = recipients.slice(i, i + CHUNK).map((uid) => ({
        user_id: uid, type, title, message, link, is_read: false,
      }));
      const { error } = await sb.from("notifications").insert(chunk);
      if (error) throw error;
      sent += chunk.length;
      progress.textContent = `Sent ${sent} / ${recipients.length}...`;
    }

    if (alsoPush) {
      const { error: pushErr } = await sb.from("push_announcements").insert({
        title,
        body: message,
        url: link || "/",
        segment: audience,
        created_by: currentNotifAdmin.id,
      });
      if (pushErr) console.warn("push_announcements:", pushErr.message);
    }

    await writeAdminAudit("broadcast_sent", "notifications", audience, { title, recipients: sent, web_push: alsoPush });
    showToast(`Broadcast sent to ${sent} users`, "success");
    progress.textContent = `Done — ${sent} users notified${alsoPush ? " + Web Push queued" : ""}.`;
    document.getElementById("broadcast-form").reset();
    document.getElementById("broadcast-also-push").checked = true;
    await refreshNotificationsPage();
  } catch (err) {
    showToast("Broadcast failed: " + err.message, "error");
    progress.textContent = "";
  }

  btn.disabled = false;
  btn.textContent = "Send broadcast";
}
