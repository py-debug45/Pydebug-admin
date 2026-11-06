// admin-community.js — Community chat moderation, flags, classrooms, institute leads, feedback & referrals.

let currentCommAdmin = null;
let allPosts = [];
let allFlags = [];
let allClassrooms = [];
let classroomMemberCounts = {};
let allEnquiries = [];
let allFeedback = [];
let allReferrals = [];
let commUsers = {};
let flagComments = {};

onAdminReady(async () => {
  currentCommAdmin = await requirePerm("community.read");
  if (!currentCommAdmin) return;

  suggestJoinCode();
  bindCommTabs();
  await loadCommunityHub();

  document.getElementById("chat-search").addEventListener("input", debounce(renderChat, 250));
  document.getElementById("chat-filter").addEventListener("change", renderChat);
  document.getElementById("flag-filter").addEventListener("change", renderFlags);
  document.getElementById("refresh-comm-btn").addEventListener("click", loadCommunityHub);
  document.getElementById("create-classroom-form").addEventListener("submit", createClassroom);

  document.getElementById("comm-modal-close").addEventListener("click", () => {
    document.getElementById("comm-modal").classList.remove("is-open");
  });
  document.getElementById("comm-modal").addEventListener("click", (e) => {
    if (e.target.id === "comm-modal") document.getElementById("comm-modal").classList.remove("is-open");
  });

  if (typeof whenAdminAIReady === "function") {
    whenAdminAIReady().then(() => renderChat());
  }
});

function suggestJoinCode() {
  const el = document.getElementById("cls-code");
  if (el && !el.value) {
    el.value = "PYD-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  }
}

function bindCommTabs() {
  document.querySelectorAll("[data-comm-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.commTab;
      document.querySelectorAll("[data-comm-tab]").forEach((b) => b.classList.toggle("is-active", b === btn));
      document.querySelectorAll(".admin-tab-panel").forEach((p) => {
        p.classList.toggle("is-active", p.id === `panel-${tab}`);
      });
    });
  });
}

function commUserLabel(uid) {
  const u = commUsers[uid];
  if (!u) return uid ? uid.slice(0, 8) + "…" : "—";
  return u.display_name || u.full_name || u.email || uid.slice(0, 8);
}

async function loadCommunityHub() {
  const btn = document.getElementById("refresh-comm-btn");
  btn.disabled = true;
  const hintEl = document.getElementById("comm-hint");
  if (hintEl) hintEl.innerHTML = "";

  const sources = [
    ["community_posts", fetchAdminRows("community_posts", "*", "created_at")],
    ["discussion_flags", fetchAdminRows("discussion_flags", "*", "created_at")],
    ["classrooms", fetchAdminRows("classrooms", "*", "created_at")],
    ["classroom_members", fetchAdminRows("classroom_members", "classroom_id, student_id", "joined_at")],
    ["institute_enquiries", fetchAdminRows("institute_enquiries", "*", "created_at")],
    ["learner_feedback", fetchAdminRows("learner_feedback", "*", "created_at")],
    ["referrals", fetchAdminRows("referrals", "*", "created_at")],
  ];
  const results = await Promise.allSettled(sources.map(([, promise]) => promise));
  const [postsRes, flagsRes, clsRes, memRes, enqRes, fbRes, refRes] = results;

  const warnings = results
    .map((res, idx) => (res.status === "rejected" ? `${sources[idx][0]}: ${res.reason?.message || "unavailable"}` : null))
    .filter(Boolean);
  if (warnings.length && hintEl) {
    hintEl.innerHTML =
      `<div class="admin-hint">Some community tables could not be read (${escapeHtml(warnings.join("; "))}). Run the latest SQL migration in Supabase.</div>`;
  }

  allPosts = postsRes.status === "fulfilled" ? postsRes.value.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) : [];
  allFlags = flagsRes.status === "fulfilled" ? flagsRes.value.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) : [];
  allClassrooms = clsRes.status === "fulfilled" ? clsRes.value.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) : [];
  allEnquiries = enqRes.status === "fulfilled" ? enqRes.value.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) : [];
  allFeedback = fbRes.status === "fulfilled" ? fbRes.value.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) : [];
  allReferrals = refRes.status === "fulfilled" ? refRes.value.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) : [];

  classroomMemberCounts = {};
  if (memRes.status === "fulfilled") {
    memRes.value.forEach((m) => {
      classroomMemberCounts[m.classroom_id] = (classroomMemberCounts[m.classroom_id] || 0) + 1;
    });
  }

  const uids = new Set();
  allPosts.forEach((p) => { if (p.user_id) uids.add(p.user_id); });
  allFlags.forEach((f) => { if (f.reporter_id) uids.add(f.reporter_id); });
  allFeedback.forEach((f) => { if (f.user_id) uids.add(f.user_id); });
  allReferrals.forEach((r) => {
    if (r.referrer_id) uids.add(r.referrer_id);
    if (r.referred_id) uids.add(r.referred_id);
  });

  commUsers = {};
  const idList = [...uids];
  for (let i = 0; i < idList.length; i += 200) {
    const { data } = await sb.from("profiles").select("id, display_name, full_name, email, status, status_until, status_reason").in("id", idList.slice(i, i + 200));
    (data || []).forEach((u) => { commUsers[u.id] = u; });
  }

  flagComments = {};
  const discIds = [...new Set(allFlags.map((f) => f.discussion_id).filter(Boolean))];
  if (discIds.length) {
    const { data: comments } = await sb.from("problem_discussions").select("id, content, user_id, problem_id").in("id", discIds);
    (comments || []).forEach((c) => { flagComments[c.id] = c; });
  }

  const pendingFlags = allFlags.filter((f) => !f.resolved_at).length;
  document.getElementById("tab-count-chat").textContent = allPosts.length;
  document.getElementById("tab-count-flags").textContent = pendingFlags;
  document.getElementById("tab-count-institutes").textContent = allClassrooms.length + allEnquiries.length;
  document.getElementById("tab-count-growth").textContent = allFeedback.length + allReferrals.length;

  renderChat();
  renderFlags();
  renderInstitutes();
  renderGrowth();
  btn.disabled = false;
}

function isPostFlaggedByAI(p) {
  if (typeof AI_scanText !== "function") return false;
  return AI_scanText(`${p.content || ""}\n${p.python_code || ""}`).flagged;
}

function renderChat() {
  const withCode = allPosts.filter((p) => !!p.python_code).length;
  const likes = allPosts.reduce((s, p) => s + (Number(p.like_count) || 0), 0);
  const aiFlagged = allPosts.filter(isPostFlaggedByAI).length;

  document.getElementById("chat-total").textContent = allPosts.length.toLocaleString("en-IN");
  document.getElementById("chat-code").textContent = withCode.toLocaleString("en-IN");
  document.getElementById("chat-likes").textContent = likes.toLocaleString("en-IN");
  document.getElementById("chat-ai-flagged").textContent = aiFlagged.toLocaleString("en-IN");

  const search = document.getElementById("chat-search").value.trim().toLowerCase();
  const filter = document.getElementById("chat-filter").value;

  const rows = allPosts.filter((p) => {
    if (filter === "main" && p.parent_post_id) return false;
    if (filter === "reply" && !p.parent_post_id) return false;
    if (filter === "code" && !p.python_code) return false;
    if (filter === "flagged" && !isPostFlaggedByAI(p)) return false;
    if (search) {
      const hay = `${p.content || ""} ${p.python_code || ""} ${commUserLabel(p.user_id)}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const tbody = document.getElementById("chat-tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No community posts match your filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.slice(0, 150).map((p) => {
    const u = commUsers[p.user_id];
    const badge = typeof AI_badgeFor === "function" ? AI_badgeFor(`${p.content || ""} ${p.python_code || ""}`) : "";
    return `<tr>
      <td class="muted" title="${escapeHtml(fmtDateTime(p.created_at))}">${escapeHtml(timeAgo(p.created_at))}</td>
      <td>
        <a href="user-detail.html?id=${encodeURIComponent(p.user_id || "")}">${escapeHtml(commUserLabel(p.user_id))}</a>
        ${accountStatusBadge(u)}
      </td>
      <td class="comment-excerpt" title="${escapeHtml(p.content || "")}">${escapeHtml(p.content || "")}</td>
      <td>${p.python_code ? '<span class="tag tag--info">&lt;/&gt; Python</span>' : '<span class="muted">—</span>'}</td>
      <td class="muted">${Number(p.like_count) || 0} ♥ · ${Number(p.reply_count) || 0} ↩</td>
      <td>${p.parent_post_id ? '<span class="tag tag--info">Reply</span>' : '<span class="tag tag--unknown">Post</span>'}${badge}</td>
      <td class="row-actions">
        <button class="btn btn--secondary btn--sm" data-view-post="${escapeHtml(p.id)}">View</button>
        <button class="btn btn--secondary btn--sm" data-mute-author="${escapeHtml(p.user_id || "")}">Mute 24h</button>
        <button class="btn btn--danger btn--sm" data-del-post="${escapeHtml(p.id)}">Delete</button>
      </td>
    </tr>`;
  }).join("");

  if (tbody.dataset.bound !== "1") {
    tbody.dataset.bound = "1";
    tbody.addEventListener("click", (e) => {
      const viewBtn = e.target.closest("button[data-view-post]");
      if (viewBtn) return openPostModal(viewBtn.dataset.viewPost);
      const muteBtn = e.target.closest("button[data-mute-author]");
      if (muteBtn) return quickMuteAuthor(muteBtn.dataset.muteAuthor, muteBtn);
      const delBtn = e.target.closest("button[data-del-post]");
      if (delBtn) return deleteCommunityPost(delBtn.dataset.delPost, delBtn);
    });
  }
}

function openPostModal(id) {
  const p = allPosts.find((x) => String(x.id) === String(id));
  if (!p) return;
  document.getElementById("comm-modal-title").textContent = p.parent_post_id ? "Community Reply" : "Community Post";
  document.getElementById("comm-modal-meta").innerHTML =
    `Author: <strong>${escapeHtml(commUserLabel(p.user_id))}</strong> · Posted ${escapeHtml(fmtDateTime(p.created_at))} · ${Number(p.like_count) || 0} likes`;
  document.getElementById("comm-modal-text").textContent = p.content || "";
  const codeEl = document.getElementById("comm-modal-code");
  if (p.python_code) {
    codeEl.style.display = "block";
    codeEl.textContent = p.python_code;
  } else {
    codeEl.style.display = "none";
  }
  document.getElementById("comm-modal").classList.add("is-open");
}

async function deleteCommunityPost(id, btn) {
  if (!ensureCan("community.write")) return;
  if (!confirm("Delete this community post (and any replies to it) for everyone?")) return;
  btn.disabled = true;
  const { error } = await sb.rpc("admin_delete_community_post", {
    target_post_id: id,
    delete_reason: "Admin moderation",
  });
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    btn.disabled = false;
    return;
  }
  showToast("Community post deleted", "success");
  await loadCommunityHub();
}

async function quickMuteAuthor(userId, btn) {
  if (!userId) return;
  if (userId === currentCommAdmin.id) {
    showToast("Cannot mute your own admin account", "error");
    return;
  }
  if (!confirm(`Mute ${commUserLabel(userId)} for 24 hours?`)) return;
  btn.disabled = true;
  const until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const { error } = await sb.rpc("admin_panel_update_profile", {
    target_user: userId,
    patch: { status: "muted", status_reason: "Community moderation (24h mute)", status_until: until },
  });
  btn.disabled = false;
  if (error) {
    showToast("Mute failed: " + error.message, "error");
    return;
  }
  showToast("User muted for 24 hours", "success");
  await loadCommunityHub();
}

function renderFlags() {
  const mode = document.getElementById("flag-filter").value;
  const rows = allFlags.filter((f) => {
    if (mode === "pending") return !f.resolved_at;
    if (mode === "resolved") return !!f.resolved_at;
    return true;
  });

  const tbody = document.getElementById("flags-tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No ${escapeHtml(mode)} discussion flags 🎉</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((f) => {
    const c = flagComments[f.discussion_id];
    const resolved = !!f.resolved_at;
    return `<tr>
      <td class="muted">${escapeHtml(timeAgo(f.created_at))}</td>
      <td>${escapeHtml(commUserLabel(f.reporter_id))}</td>
      <td><span class="tag tag--failed">${escapeHtml(f.reason || "reported")}</span></td>
      <td class="comment-excerpt">${c ? escapeHtml(c.content || "") : '<span class="muted">Comment already deleted</span>'}</td>
      <td>${resolved ? statusBadge("approved") : statusBadge("pending")}</td>
      <td class="row-actions">
        ${resolved
          ? `<span class="muted" style="font-size:0.76rem">${escapeHtml(f.resolution || "resolved")}</span>`
          : `<button class="btn btn--secondary btn--sm" data-resolve-flag="${escapeHtml(f.id)}" data-del="0">Dismiss</button>
             <button class="btn btn--danger btn--sm" data-resolve-flag="${escapeHtml(f.id)}" data-del="1">Delete &amp; Resolve</button>`}
      </td>
    </tr>`;
  }).join("");

  if (tbody.dataset.bound !== "1") {
    tbody.dataset.bound = "1";
    tbody.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-resolve-flag]");
      if (!btn) return;
      const del = btn.dataset.del === "1";
      if (del && !confirm("Delete the reported comment and mark this flag resolved?")) return;
      btn.disabled = true;
      const { error } = await sb.rpc("admin_resolve_discussion_flag", {
        target_flag_id: btn.dataset.resolveFlag,
        resolution_text: del ? "comment_deleted" : "dismissed",
        delete_comment: del,
      });
      if (error) {
        showToast("Could not resolve flag: " + error.message, "error");
        btn.disabled = false;
        return;
      }
      showToast(del ? "Comment deleted & flag resolved" : "Flag dismissed", "success");
      await loadCommunityHub();
    });
  }
}

async function createClassroom(e) {
  e.preventDefault();
  const name = document.getElementById("cls-name").value.trim();
  const institute_name = document.getElementById("cls-inst").value.trim() || null;
  const join_code = document.getElementById("cls-code").value.trim().toUpperCase();
  const syllabus_goal = document.getElementById("cls-goal").value;

  if (!name || !join_code) {
    showToast("Batch name and join code are required", "error");
    return;
  }

  const { error } = await sb.from("classrooms").insert({
    teacher_id: currentCommAdmin.id,
    name,
    institute_name,
    join_code,
    syllabus_goal,
    is_active: true,
  });
  if (error) {
    showToast("Could not create classroom: " + error.message, "error");
    return;
  }
  await writeAdminAudit("classroom_created", "classroom", join_code, { name, institute_name, syllabus_goal });
  showToast(`Classroom "${name}" (${join_code}) created`, "success");
  document.getElementById("create-classroom-form").reset();
  suggestJoinCode();
  await loadCommunityHub();
}

function renderInstitutes() {
  document.getElementById("cls-count").textContent = allClassrooms.length;
  document.getElementById("enquiries-count").textContent = allEnquiries.length;

  const clsBody = document.getElementById("classrooms-tbody");
  clsBody.innerHTML = allClassrooms.length
    ? allClassrooms.map((c) => `<tr>
        <td><strong>${escapeHtml(c.name)}</strong><div class="muted" style="font-size:0.74rem">${escapeHtml(c.institute_name || "")}</div></td>
        <td class="mono"><span class="tag tag--info">${escapeHtml(c.join_code)}</span></td>
        <td><strong>${classroomMemberCounts[c.id] || 0}</strong></td>
        <td class="muted">${escapeHtml(c.syllabus_goal || "—")}</td>
        <td>
          <button class="btn btn--secondary btn--sm" data-toggle-cls="${escapeHtml(c.id)}" data-active="${c.is_active ? "1" : "0"}">
            ${c.is_active ? "Archive" : "Activate"}
          </button>
        </td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="empty-row">No classrooms created yet.</td></tr>`;

  if (clsBody.dataset.bound !== "1") {
    clsBody.dataset.bound = "1";
    clsBody.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-toggle-cls]");
      if (!btn) return;
      const next = btn.dataset.active !== "1";
      btn.disabled = true;
      const { error } = await sb.from("classrooms").update({ is_active: next }).eq("id", btn.dataset.toggleCls);
      if (error) {
        showToast(error.message, "error");
        btn.disabled = false;
        return;
      }
      showToast(next ? "Classroom activated" : "Classroom archived", "success");
      await loadCommunityHub();
    });
  }

  const enqBody = document.getElementById("enquiries-tbody");
  enqBody.innerHTML = allEnquiries.length
    ? allEnquiries.map((q) => `<tr>
        <td class="muted">${escapeHtml(timeAgo(q.created_at))}</td>
        <td>
          <strong>${escapeHtml(q.institute_name)}</strong>
          <div class="muted" style="font-size:0.76rem">${escapeHtml(q.contact_name)} · <a href="mailto:${escapeHtml(q.work_email)}">${escapeHtml(q.work_email)}</a></div>
          ${q.notes ? `<div class="muted" style="font-size:0.75rem;margin-top:3px">${escapeHtml(q.notes.slice(0, 140))}</div>` : ""}
        </td>
        <td>${q.student_count ?? "—"}</td>
        <td class="muted">${escapeHtml(q.primary_goal || "—")}${q.expected_start ? ` · ${escapeHtml(q.expected_start)}` : ""}</td>
        <td>${statusBadge(q.status)}</td>
        <td>
          <select data-enq-status="${escapeHtml(q.id)}" style="min-height:32px;font-size:0.78rem">
            ${["new", "contacted", "pilot_active", "closed"].map((st) => `<option value="${st}" ${q.status === st ? "selected" : ""}>${st}</option>`).join("")}
          </select>
        </td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="empty-row">No institute enquiries submitted yet.</td></tr>`;

  if (enqBody.dataset.bound !== "1") {
    enqBody.dataset.bound = "1";
    enqBody.addEventListener("change", async (e) => {
      const sel = e.target.closest("select[data-enq-status]");
      if (!sel) return;
      const { error } = await sb.from("institute_enquiries")
        .update({ status: sel.value, updated_at: new Date().toISOString() })
        .eq("id", sel.dataset.enqStatus);
      if (error) {
        showToast(error.message, "error");
        return;
      }
      await writeAdminAudit("enquiry_status_updated", "institute_enquiry", sel.dataset.enqStatus, { status: sel.value });
      showToast("Enquiry status updated", "success");
      await loadCommunityHub();
    });
  }
}

function renderGrowth() {
  document.getElementById("feedback-count").textContent = allFeedback.length;
  document.getElementById("referrals-count").textContent = allReferrals.length;

  const fbBody = document.getElementById("feedback-tbody");
  fbBody.innerHTML = allFeedback.length
    ? allFeedback.map((f) => `<tr>
        <td class="muted">${escapeHtml(timeAgo(f.created_at))}</td>
        <td><a href="user-detail.html?id=${encodeURIComponent(f.user_id || "")}">${escapeHtml(commUserLabel(f.user_id))}</a></td>
        <td class="comment-excerpt" title="${escapeHtml(f.content || "")}">${escapeHtml(f.content || "")}</td>
        <td>${f.consent_publish ? '<span class="tag tag--solved">Consented</span>' : '<span class="tag tag--unknown">Private</span>'}</td>
        <td>${f.approved ? statusBadge("approved") : statusBadge("pending")}</td>
        <td>
          ${f.consent_publish
            ? `<button class="btn btn--secondary btn--sm" data-approve-fb="${escapeHtml(f.id)}" data-next="${f.approved ? "0" : "1"}">${f.approved ? "Unpublish" : "Approve quote"}</button>`
            : '<span class="muted" style="font-size:0.75rem">No consent</span>'}
        </td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="empty-row">No learner feedback submitted yet.</td></tr>`;

  if (fbBody.dataset.bound !== "1") {
    fbBody.dataset.bound = "1";
    fbBody.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-approve-fb]");
      if (!btn) return;
      const approve = btn.dataset.next === "1";
      btn.disabled = true;
      const { error } = await sb.from("learner_feedback").update({
        approved: approve,
        approved_by: approve ? currentCommAdmin.id : null,
        approved_at: approve ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }).eq("id", btn.dataset.approveFb);
      if (error) {
        showToast(error.message, "error");
        btn.disabled = false;
        return;
      }
      await writeAdminAudit(approve ? "feedback_approved" : "feedback_unpublished", "learner_feedback", btn.dataset.approveFb, { approved: approve });
      showToast(approve ? "Testimonial approved for publication" : "Testimonial unpublished", "success");
      await loadCommunityHub();
    });
  }

  const refBody = document.getElementById("referrals-tbody");
  refBody.innerHTML = allReferrals.length
    ? allReferrals.map((r) => `<tr>
        <td class="muted">${escapeHtml(timeAgo(r.created_at))}</td>
        <td><a href="user-detail.html?id=${encodeURIComponent(r.referrer_id || "")}">${escapeHtml(commUserLabel(r.referrer_id))}</a></td>
        <td><a href="user-detail.html?id=${encodeURIComponent(r.referred_id || "")}">${escapeHtml(commUserLabel(r.referred_id))}</a></td>
        <td>${statusBadge(r.status)}</td>
        <td class="muted">${escapeHtml(r.invalid_reason || (r.rewarded_at ? "Reward granted" : "Clean"))}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="empty-row">No referrals recorded yet.</td></tr>`;
}
