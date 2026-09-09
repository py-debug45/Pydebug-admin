// admin-notifications.js — broadcast announcements to user-panel bells
// + review recent notifications.
//
// Table: notifications(id, user_id, type, title, message, link, is_read,
// created_at). The setup SQL creates it if it doesn't exist yet.

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  await loadRecent();
  document.getElementById("broadcast-form").addEventListener("submit", sendBroadcast);
});

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
      `<div class="admin-hint">Couldn't read <code>notifications</code> (${escapeHtml(error.message)}). ` +
      `Run <code>supabase-admin-setup.sql</code> in Supabase → SQL Editor (it creates the table if missing), then reload.</div>`;
    return;
  }

  const rows = data || [];
  document.getElementById("notif-count").textContent = rows.length >= 100 ? "latest 100" : `${rows.length}`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No notifications sent yet — use the form above.</td></tr>`;
    return;
  }

  const userIds = [...new Set(rows.map((n) => n.user_id).filter(Boolean))];
  let emailById = {};
  if (userIds.length) {
    const { data: users } = await sb.from("profiles").select("id, email").in("id", userIds);
    (users || []).forEach((u) => { emailById[u.id] = u.email; });
  }

  tbody.innerHTML = "";
  rows.forEach((n) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="muted" title="${escapeHtml(fmtDateTime(n.created_at))}">${escapeHtml(timeAgo(n.created_at))}</td>
      <td>${escapeHtml(emailById[n.user_id] || "—")}</td>
      <td>${escapeHtml(n.title || "")}</td>
      <td class="comment-excerpt" title="${escapeHtml(n.message || "")}">${escapeHtml(n.message || "")}</td>
      <td>${n.is_read ? '<span class="tag tag--unknown">Read</span>' : '<span class="tag tag--info">Unread</span>'}</td>
      <td class="row-actions">
        <button class="btn btn--danger btn--sm" data-del-notif="${n.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-del-notif]").forEach((btn) =>
    btn.addEventListener("click", () => deleteNotification(btn.dataset.delNotif, btn))
  );
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
  await loadRecent();
}

async function sendBroadcast(e) {
  e.preventDefault();
  const title = document.getElementById("broadcast-title").value.trim();
  const message = document.getElementById("broadcast-message").value.trim();
  let link = document.getElementById("broadcast-link").value.trim();
  const type = document.getElementById("broadcast-type").value;
  const audience = document.getElementById("broadcast-audience").value;
  const btn = document.getElementById("broadcast-send-btn");
  const progress = document.getElementById("broadcast-progress");

  if (!title || !message) {
    showToast("Title and message are required", "error");
    return;
  }
  // The user panel only follows internal links — block javascript:/external URLs.
  if (link && !link.startsWith("/")) {
    showToast("Link must be an in-app path starting with / (e.g. /problems.html)", "error");
    return;
  }
  if (link === "") link = null;

  btn.disabled = true;
  btn.textContent = "Sending...";
  progress.textContent = "Finding recipients...";

  try {
    // Page through profiles so big audiences don't get cut at 1000 rows.
    let recipients = [];
    let from = 0;
    const PAGE = 1000;
    for (;;) {
      // Pull expiry so "premium" / "free" match isPremiumUser() (expired
      // premium is not an active paid user).
      let q = sb.from("profiles").select("id, is_premium, premium_expires_at").order("created_at", { ascending: true }).range(from, from + PAGE - 1);
      const { data, error } = await q;
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

    if (!confirm(`Send "${title}" to ${recipients.length} user${recipients.length === 1 ? "" : "s"}?`)) {
      progress.textContent = "";
      btn.disabled = false;
      btn.textContent = "Send broadcast";
      return;
    }

    // Insert in chunks so large broadcasts don't hit payload limits.
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

    showToast(`Broadcast sent to ${sent} users`, "success");
    progress.textContent = `Done — ${sent} users notified.`;
    document.getElementById("broadcast-form").reset();
    await loadRecent();
  } catch (err) {
    showToast("Broadcast failed: " + err.message, "error");
    progress.textContent = "";
  }

  btn.disabled = false;
  btn.textContent = "Send broadcast";
}
