// admin-problem-form.js — create & edit Fix-the-Bug, Predict-Output, and Write-Code problems,
// with URL slugs, test_cases JSON, solution_code, quiet-publish flag, and Hindi localization.

let editingId = null;
let editingBlocked = false;
let slugTouchedManually = false;
let hintValues = [];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

onAdminReady(async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  editingId = qs("id");

  if (editingId && !UUID_RE.test(editingId)) {
    showToast("Invalid problem id — redirecting to dashboard.", "error");
    setTimeout(() => (window.location.href = "dashboard.html"), 1200);
    return;
  }

  const titleInput = document.getElementById("problem-title-input");
  const slugInput = document.getElementById("problem-slug-input");
  const numInput = document.getElementById("problem-number-input");

  slugInput.addEventListener("input", () => {
    slugTouchedManually = slugInput.value.trim().length > 0;
  });

  titleInput.addEventListener("input", () => {
    if (slugTouchedManually) return;
    const base = slugifyProblemTitle(titleInput.value);
    const n = parseInt(numInput.value, 10);
    slugInput.value = base ? (n ? `${base}-${n}` : base) : "";
  });

  if (editingId) {
    document.getElementById("form-title").textContent = "Edit Problem";
    slugTouchedManually = true;
    await loadExisting(editingId);
  } else {
    document.getElementById("form-title").textContent = "Add New Problem";
    renderHints();
    const { data } = await sb.from("problems").select("problem_number").order("problem_number", { ascending: false }).limit(1);
    const maxNum = Number(data?.[0]?.problem_number) || 0;
    numInput.value = maxNum + 1;
  }

  document.getElementById("add-hint-btn").addEventListener("click", () => {
    hintValues.push("");
    renderHints();
  });

  document.getElementById("problem-form").addEventListener("submit", saveProblem);
  document.getElementById("problem-type").addEventListener("change", updateFieldLabels);
  updateFieldLabels();
});

function updateFieldLabels() {
  const type = document.getElementById("problem-type").value;
  const codeLabel = document.getElementById("starter-code-label");
  const outputLabel = document.getElementById("expected-output-label");
  const tcField = document.getElementById("test-cases-field");

  if (type === "bug") {
    codeLabel.textContent = "Buggy code (the user will edit and fix this)";
    outputLabel.textContent = "Correct output (compared against the user's fixed-code run)";
    tcField.style.display = "none";
  } else if (type === "coding") {
    codeLabel.textContent = "Starter signature / scaffold (the user writes the implementation)";
    outputLabel.textContent = "Sample expected output (for default run)";
    tcField.style.display = "";
  } else {
    codeLabel.textContent = "Code shown to the user (read-only — they predict its output)";
    outputLabel.textContent = "Exact expected output";
    tcField.style.display = "none";
  }
}

async function loadExisting(id) {
  const { data: p, error } = await sb.from("problems").select("*").eq("id", id).single();
  if (error || !p) {
    editingBlocked = true;
    showToast("Problem not found", "error");
    setTimeout(() => (window.location.href = "dashboard.html"), 1200);
    return;
  }

  document.getElementById("problem-type").value = ["bug", "question", "coding"].includes(p.type) ? p.type : "bug";
  document.getElementById("problem-status-input").value = ["published", "draft", "archived"].includes(p.status) ? p.status : "published";
  document.getElementById("problem-title-input").value = p.title || "";
  document.getElementById("problem-slug-input").value = p.slug || "";
  slugTouchedManually = !!(p.slug && p.slug.trim());
  document.getElementById("problem-description").value = p.description || "";
  document.getElementById("problem-difficulty-input").value = p.difficulty || "easy";

  const topicSel = document.getElementById("problem-topic-input");
  if ([...topicSel.options].some((o) => o.value === (p.topic || "").toLowerCase())) {
    topicSel.value = (p.topic || "").toLowerCase();
  }
  document.getElementById("problem-number-input").value = p.problem_number ?? "";
  document.getElementById("problem-battle-error").value = p.battle_error || "";
  document.getElementById("problem-premium").checked = !!p.is_premium;
  document.getElementById("problem-skip-notif").checked = !!p.admin_skip_notification;
  document.getElementById("starter-code").value = p.starter_code || "";
  document.getElementById("expected-output").value = p.expected_output || "";
  document.getElementById("problem-solution-code").value = p.solution_code || "";
  document.getElementById("problem-test-cases").value =
    Array.isArray(p.test_cases) && p.test_cases.length ? JSON.stringify(p.test_cases, null, 2) : "";

  document.getElementById("problem-title-hi").value = p.title_hi || "";
  document.getElementById("problem-description-hi").value = p.description_hi || "";
  document.getElementById("problem-hints-hi").value = Array.isArray(p.hints_hi) ? p.hints_hi.join("\n") : "";

  hintValues = Array.isArray(p.hints) ? [...p.hints] : [];
  renderHints();
  updateFieldLabels();
}

function renderHints() {
  const container = document.getElementById("hints-container");
  container.innerHTML = "";
  if (hintValues.length === 0) hintValues.push("");

  hintValues.forEach((value, i) => {
    const row = document.createElement("div");
    row.className = "hint-input-row";
    row.innerHTML = `
      <input type="text" class="hint-input" data-index="${i}" value="${escapeAttr(value)}" placeholder="Hint ${i + 1}">
      <button type="button" class="btn btn--secondary btn--sm remove-hint-btn" data-index="${i}">✕</button>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll(".hint-input").forEach((input) => {
    input.addEventListener("input", (e) => {
      hintValues[Number(e.target.dataset.index)] = e.target.value;
    });
  });
  container.querySelectorAll(".remove-hint-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      hintValues.splice(Number(btn.dataset.index), 1);
      renderHints();
    });
  });
}

function escapeAttr(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function saveProblem(e) {
  e.preventDefault();
  if (editingBlocked) return;

  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Saving...";

  const resetBtn = () => {
    btn.disabled = false;
    btn.textContent = "Save Problem";
  };

  const numRaw = document.getElementById("problem-number-input").value;
  const problemNumber = numRaw === "" ? null : parseInt(numRaw, 10);
  const title = document.getElementById("problem-title-input").value.trim();
  const type = document.getElementById("problem-type").value;
  const rawSlug = slugifyProblemTitle(document.getElementById("problem-slug-input").value);
  const autoSlug = slugifyProblemTitle(title);
  const slug = rawSlug || (autoSlug ? (problemNumber ? `${autoSlug}-${problemNumber}` : autoSlug) : null);

  let testCases = [];
  const rawTc = document.getElementById("problem-test-cases").value.trim();
  if (rawTc) {
    try {
      const parsed = JSON.parse(rawTc);
      if (!Array.isArray(parsed)) throw new Error("test_cases must be a JSON array");
      testCases = parsed;
    } catch (err) {
      showToast("Invalid Test Cases JSON: " + err.message, "error");
      resetBtn();
      return;
    }
  } else if (type === "coding") {
    showToast("Write Code problems should include at least 1 JSON test case.", "error");
    resetBtn();
    return;
  }

  const hintsHiRaw = document.getElementById("problem-hints-hi").value;
  const hintsHi = hintsHiRaw
    .split("\n")
    .map((h) => h.trim())
    .filter(Boolean);

  const payload = {
    type,
    status: document.getElementById("problem-status-input").value,
    title,
    slug,
    description: document.getElementById("problem-description").value.trim(),
    difficulty: document.getElementById("problem-difficulty-input").value,
    topic: document.getElementById("problem-topic-input").value,
    problem_number: problemNumber,
    battle_error: document.getElementById("problem-battle-error").value.trim() || null,
    is_premium: document.getElementById("problem-premium").checked,
    admin_skip_notification: document.getElementById("problem-skip-notif").checked,
    starter_code: document.getElementById("starter-code").value,
    expected_output: document.getElementById("expected-output").value,
    solution_code: document.getElementById("problem-solution-code").value.trim() || null,
    test_cases: testCases,
    hints: hintValues.filter((h) => h.trim() !== ""),
    title_hi: document.getElementById("problem-title-hi").value.trim() || null,
    description_hi: document.getElementById("problem-description-hi").value.trim() || null,
    hints_hi: hintsHi,
  };

  if (!payload.title) {
    showToast("Title is required.", "error");
    resetBtn();
    return;
  }
  if (!payload.starter_code.trim()) {
    showToast("Code is required.", "error");
    resetBtn();
    return;
  }
  if (!payload.expected_output.trim()) {
    showToast("Expected output is required.", "error");
    resetBtn();
    return;
  }

  let error;
  try {
    if (editingId) {
      ({ error } = await sb.from("problems").update(payload).eq("id", editingId));
    } else {
      ({ error } = await sb.from("problems").insert(payload));
    }
  } catch (err) {
    error = err;
  }

  if (error) {
    showToast("Could not save: " + error.message, "error");
    resetBtn();
    return;
  }

  await writeAdminAudit(editingId ? "problem_updated" : "problem_created", "problem", editingId || slug || title, {
    type: payload.type,
    problem_number: payload.problem_number,
    status: payload.status,
  });
  showToast(editingId ? "Problem updated" : "Problem added", "success");
  setTimeout(() => (window.location.href = "dashboard.html"), 900);
}
