// admin-discussions.js — moderate problem comments from the user panel.
//
// Tables (user panel): problem_discussions(id, problem_id, user_id, content,
// is_solution, like_count, parent_comment_id, created_at, updated_at) and
// discussion_likes(user_id, comment_id).

let allComments = [];
let filteredComments = [];
let discUserMap = {};
let discProblemMap = {};
const DISC_PAGE_SIZE = 100;
let discVisibleCount = DISC_PAGE_SIZE;

onAdminReady(async () => {
  const admin = await requirePerm("community.read");
  if (!admin) return;

  await loadComments();

  document.getElementById("discussion-search").addEventListener("input", debounce(applyDiscussionFilters, 300));
  document.getElementById("discussion-filter-type").addEventListener("change", applyDiscussionFilters);
  document.getElementById("discussions-load-more").addEventListener("click", () => {
    discVisibleCount += DISC_PAGE_SIZE;
    renderComments();
  });
  document.getElementById("export-discussions-btn").addEventListener("click", exportComments);

  document.getElementById("comment-modal-close").addEventListener("click", closeCommentModal);
  document.getElementById("comment-modal").addEventListener("click", (e) => {
    if (e.target.id === "comment-modal") closeCommentModal();
  });
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

function commentType(c) {
  if (c.is_solution) return "solution";
  if (c.parent_comment_id) return "reply";
  return "top";
}

function commentTypeBadge(c) {
  const t = commentType(c);
  if (t === "solution") return '<span class="tag tag--solved">Solution ✓</span>';
  if (t === "reply") return '<span class="tag tag--info">Reply</span>';
  return '<span class="tag tag--unknown">Comment</span>';
}

async function loadComments() {
  const tbody = document.getElementById("discussions-tbody");
  tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Loading comments...</td></tr>`;

  const { data, error } = await sb
    .from("problem_discussions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Could not load comments.</td></tr>`;
    document.getElementById("discussions-hint").innerHTML =
      `<div class="admin-hint">Couldn't read <code>problem_discussions</code> (${escapeHtml(error.message)}). ` +
      `Run <code>supabase-admin-setup.sql</code> in Supabase → SQL Editor, then reload.</div>`;
    return;
  }

  allComments = data || [];

  const userIds = [...new Set(allComments.map((c) => c.user_id).filter(Boolean))];
  const problemIds = [...new Set(allComments.map((c) => c.problem_id).filter(Boolean))];
  if (userIds.length) {
    const { data: users } = await sb.from("profiles").select("id, display_name, full_name, email").in("id", userIds);
    (users || []).forEach((u) => { discUserMap[u.id] = u; });
  }
  if (problemIds.length) {
    const { data: problems } = await sb.from("problems").select("id, title").in("id", problemIds);
    (problems || []).forEach((p) => { discProblemMap[p.id] = p; });
  }

  renderDiscussionStats();
  applyDiscussionFilters();
}

function renderDiscussionStats() {
  document.getElementById("disc-total").textContent = allComments.length >= 1000 ? "1000+" : allComments.length;
  document.getElementById("disc-total-sub").textContent = allComments.length >= 1000 ? "showing latest 1000" : "";
  document.getElementById("disc-solutions").textContent = allComments.filter((c) => c.is_solution).length;
  document.getElementById("disc-replies").textContent = allComments.filter((c) => c.parent_comment_id).length;
  document.getElementById("disc-likes").textContent = allComments.reduce((s, c) => s + (Number(c.like_count) || 0), 0);
}

function applyDiscussionFilters() {
  const search = document.getElementById("discussion-search").value.trim().toLowerCase();
  const type = document.getElementById("discussion-filter-type").value;

  filteredComments = allComments.filter((c) => {
    if (type !== "all" && commentType(c) !== type) return false;
    if (search) {
      const u = discUserMap[c.user_id] || {};
      const p = discProblemMap[c.problem_id] || {};
      const hay = `${c.content || ""} ${u.email || ""} ${u.display_name || ""} ${u.full_name || ""} ${p.title || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  discVisibleCount = DISC_PAGE_SIZE;
  renderComments();
}

let aiBadgeRepaintQueued = false;

function renderComments() {
  const tbody = document.getElementById("discussions-tbody");

  if (!filteredComments.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No comments found.</td></tr>`;
    document.getElementById("discussions-load-more").style.display = "none";
    return;
  }

  // One string, one DOM write, one delegated listener — the old version
  // created 100 rows and 200 listeners one at a time on every filter key.
  tbody.innerHTML = filteredComments.slice(0, discVisibleCount).map((c) => {
    const u = discUserMap[c.user_id] || {};
    const p = discProblemMap[c.problem_id] || {};
    return `<tr>
      <td class="muted" title="${escapeHtml(fmtDateTime(c.created_at))}">${escapeHtml(timeAgo(c.created_at))}</td>
      <td>${escapeHtml(p.title || "—")}</td>
      <td>${escapeHtml(displayNameOf(u))}</td>
      <td class="comment-excerpt" title="${escapeHtml((c.content || "").slice(0, 300))}">${escapeHtml(c.content || "")}</td>
      <td>${Number(c.like_count) || 0}</td>
      <td>${commentTypeBadge(c)}${typeof AI_badgeFor === "function" ? AI_badgeFor(c.content) : ""}</td>
      <td class="row-actions">
        <button class="btn btn--secondary btn--sm" data-view-comment="${c.id}">View</button>
        <button class="btn btn--danger btn--sm" data-del-comment="${c.id}">Delete</button>
      </td>
    </tr>`;
  }).join("");

  if (tbody.dataset.bound !== "1") {
    tbody.dataset.bound = "1";
    tbody.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-view-comment], button[data-del-comment]");
      if (!button) return;
      if (button.dataset.viewComment) openCommentModal(button.dataset.viewComment);
      else deleteComment(button.dataset.delComment, button);
    });
  }

  // The abuse badges come from the background-loaded AI bundle: repaint once
  // it is ready instead of making the table wait for it.
  if (!aiBadgeRepaintQueued && typeof AI_badgeFor !== "function" && typeof whenAdminAIReady === "function") {
    aiBadgeRepaintQueued = true;
    whenAdminAIReady().then(() => {
      if (typeof AI_badgeFor === "function") renderComments();
    });
  }

  document.getElementById("discussions-load-more").style.display =
    filteredComments.length > discVisibleCount ? "" : "none";
}

function openCommentModal(id) {
  const c = allComments.find((x) => String(x.id) === String(id));
  if (!c) return;
  const u = discUserMap[c.user_id] || {};
  const p = discProblemMap[c.problem_id] || {};
  document.getElementById("comment-modal-title").textContent = p.title || "Comment";
  document.getElementById("comment-modal-meta").innerHTML =
    `${commentTypeBadge(c)}` +
    `<span>${escapeHtml(u.email || displayNameOf(u))}</span>` +
    `<span>❤️ ${Number(c.like_count) || 0}</span>` +
    `<span>${escapeHtml(fmtDateTime(c.created_at))}</span>`;
  document.getElementById("comment-modal-body").textContent = c.content || "(empty)";
  document.getElementById("comment-modal").classList.add("open");
}

function closeCommentModal() {
  document.getElementById("comment-modal").classList.remove("open");
}

async function deleteComment(id, btn) {
  if (!ensureCan("community.write")) return;
  if (!confirm("Move this comment to Trash?\n\nThe comment text is archived and can be restored from Trash.")) return;
  btn.disabled = true;

  const soft = await softDeleteRow("problem_discussions", id, "deleted from discussions", "Comment");
  let error = soft.ok ? null : soft.error;

  if (!soft.ok && isMissingRpc(soft.error)) {
    // Pre-migration: likes first (in case there's no ON DELETE CASCADE).
    await sb.from("discussion_likes").delete().eq("comment_id", id);
    ({ error } = await sb.from("problem_discussions").delete().eq("id", id));
    if (!error) await writeAdminAudit("comment_deleted", "problem_discussions", id, { permanent: true });
  } else if (soft.ok) {
    // Keep the row restorable without dangling reactions.
    await sb.from("discussion_likes").delete().eq("comment_id", id);
  }

  if (error) {
    showToast("Could not delete: " + error.message + " (run supabase-admin-setup.sql?)", "error");
    btn.disabled = false;
    return;
  }
  allComments = allComments.filter((c) => String(c.id) !== String(id));
  renderDiscussionStats();
  applyDiscussionFilters();
}

function exportComments() {
  const rows = filteredComments.map((c) => ({
    id: c.id,
    date: c.created_at,
    problem: (discProblemMap[c.problem_id] || {}).title || c.problem_id,
    user: (discUserMap[c.user_id] || {}).email || c.user_id,
    type: commentType(c),
    likes: Number(c.like_count) || 0,
    content: c.content || "",
  }));
  downloadCSV("pydebug-discussions.csv", rows);
}
