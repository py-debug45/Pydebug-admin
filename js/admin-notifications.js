// admin-notifications.js — in-app bell broadcast + Web Push announcements + DB bloat hygiene.

let currentNotifAdmin = null;
const BROADCAST_PENDING_KEY = "pydebug_admin_broadcast_pending_v1";
let pendingBroadcast = null;

// Only same-origin paths can be put into a learner's notification. In
// particular, //host and /\\host would become external URLs in a browser.
function isSafeBroadcastLink(path) {
  if (!path) return true;
  return /^\/[A-Za-z0-9_./?=&%#-]*$/.test(path)
    && !path.startsWith("//")
    && !/^\/%(?:2f|5c)/i.test(path)
    && !/%(?:0a|0d)/i.test(path)
    && path.length <= 200;
}

function newBroadcastRequestId() {
  const crypto = window.crypto;
  if (!crypto) throw new Error("A secure browser is required to send a broadcast.");
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto.getRandomValues !== "function") throw new Error("A secure browser is required to send a broadcast.");
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Keep the same request ID for an unchanged retry, even after a reload in
// this tab. The database stores the ID atomically with the broadcast; a lost
// response must never cause a second batch of notifications on retry.
function getBroadcastRequest(payload) {
  const fingerprint = JSON.stringify({ admin: currentNotifAdmin && currentNotifAdmin.id, payload });
  if (!pendingBroadcast) {
    try { pendingBroadcast = JSON.parse(sessionStorage.getItem(BROADCAST_PENDING_KEY) || "null"); } catch (_) {}
  }
  if (!pendingBroadcast || pendingBroadcast.fingerprint !== fingerprint) {
    pendingBroadcast = { fingerprint, id: newBroadcastRequestId() };
    try { sessionStorage.setItem(BROADCAST_PENDING_KEY, JSON.stringify(pendingBroadcast)); } catch (_) {}
  }
  return pendingBroadcast.id;
}

function clearBroadcastRequest() {
  pendingBroadcast = null;
  try { sessionStorage.removeItem(BROADCAST_PENDING_KEY); } catch (_) {}
}

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
    document.getElementById("push-list-count").textContent = "—";
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

  try {
    const { data: deleted, error } = await sb.rpc("admin_prune_notifications", {
      older_than_days: days,
      auto_only: true,
    });
    if (error) throw error;
    showToast(`Cleaned ${(Number(deleted) || 0).toLocaleString("en-IN")} bloated notifications`, "success");
    await refreshNotificationsPage();
  } catch (error) {
    showToast("Prune failed: " + (error.message || "Please try again"), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
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

  document.getElementById("notifications-hint").innerHTML = "";
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
  try {
    const { error } = await sb.from("notifications").delete().eq("id", id);
    if (error) throw error;
    showToast("Notification deleted", "success");
    await refreshNotificationsPage();
  } catch (error) {
    showToast("Could not delete: " + (error.message || "Please try again"), "error");
  } finally {
    btn.disabled = false;
  }
}

async function sendBroadcast(e) {
  e.preventDefault();
  const title = document.getElementById("broadcast-title").value.trim();
  const message = document.getElementById("broadcast-message").value.trim();
  const link = document.getElementById("broadcast-link").value.trim();
  const type = document.getElementById("broadcast-type").value;
  const audience = document.getElementById("broadcast-audience").value;
  const alsoPush = document.getElementById("broadcast-also-push").checked;
  const btn = document.getElementById("broadcast-send-btn");
  const progress = document.getElementById("broadcast-progress");
  if (btn.disabled) return;

  if (!title || !message || title.length > 120 || message.length > 500) {
    showToast("A title (up to 120 characters) and message (up to 500 characters) are required", "error");
    return;
  }
  if (!isSafeBroadcastLink(link)) {
    showToast("Link must be a safe in-app path, for example /problems", "error");
    return;
  }
  if (!["announcement", "new_problem", "leaderboard_rank"].includes(type)
      || !["all", "free", "premium"].includes(audience)) {
    showToast("Choose a valid category and audience", "error");
    return;
  }

  const audienceLabel = { all: "all users", free: "free users", premium: "premium users" }[audience];
  const confirmation = alsoPush
    ? `Send "${title}" to ${audienceLabel} and request server-side push for subscribed devices?`
    : `Send "${title}" to ${audienceLabel} without requesting server-side push? Open learner tabs may still initiate push.`;
  if (!confirm(confirmation)) return;

  const payload = { title, message, link: link || null, type, audience, web_push: alsoPush };
  let requestId;
  try {
    requestId = getBroadcastRequest(payload);
  } catch (error) {
    progress.textContent = error.message;
    showToast(error.message, "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Sending...";
  progress.textContent = "Creating the broadcast...";
  try {
    // This RPC selects the audience and creates all bell rows in one DB
    // transaction. Its request ID makes an unchanged retry idempotent.
    const { data, error } = await sb.rpc("admin_send_broadcast", {
      p_request_id: requestId,
      p_title: title,
      p_message: message,
      p_link: link || null,
      p_type: type,
      p_audience: audience,
      p_web_push: alsoPush,
    });
    if (error) throw error;
    if (!data || !Number.isInteger(data.recipients) || data.recipients < 0
        || data.web_push_enabled !== alsoPush) {
      throw new Error("The server returned an unexpected response");
    }

    clearBroadcastRequest();
    const sent = data.recipients;
    if (!data.already_processed) {
      try {
        await writeAdminAudit("broadcast_sent", "notifications", audience,
          { request_id: requestId, title, recipients: sent, web_push_enabled: alsoPush });
      } catch (auditError) {
        console.warn("Broadcast audit:", auditError);
      }
    }
    if (!sent) {
      progress.textContent = "No users match this audience; nothing was sent.";
      showToast("No users match this audience", "info");
      return;
    }
    const prefix = data.already_processed ? "Previously processed" : "Done";
    progress.textContent = `${prefix} — ${sent} bell notification${sent === 1 ? "" : "s"} created.`
      + (alsoPush ? " Server-side push was enabled for subscribed devices; delivery is not guaranteed." : " No server-side push was requested; open learner tabs may still initiate push.");
    showToast(`Broadcast saved for ${sent} user${sent === 1 ? "" : "s"}`, "success");
    document.getElementById("broadcast-form").reset();
    document.getElementById("broadcast-also-push").checked = true;
    // A failed refresh does not turn an already-saved broadcast into a failure.
    try { await refreshNotificationsPage(); } catch (refreshError) { console.warn("Notification refresh:", refreshError); }
  } catch (error) {
    const missingRpc = error && (error.code === "PGRST202" || /could not find the function|function .* does not exist/i.test(error.message || ""));
    progress.textContent = missingRpc
      ? "Database update required: apply 20261028_admin_notification_safety.sql before broadcasting. Nothing was sent."
      : "Could not confirm the result: " + (error.message || "connection problem")
        + ". Retry with the same contents to avoid duplicates.";
    showToast(missingRpc ? "Database update required" : "Could not confirm broadcast", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Send broadcast";
  }
}
