// admin-problem-form.js

let editingId = null;
let editingBlocked = false; // true when the problem to edit couldn't be loaded — saving is disabled
let hintValues = [];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  editingId = qs("id");

  // Guard against malformed ids (problem-form.html?id=abc) — previously the
  // page stayed in "Edit" mode and Save would fail/behave oddly.
  if (editingId && !UUID_RE.test(editingId)) {
    showToast("Invalid problem id — redirecting to dashboard.", "error");
    setTimeout(() => (window.location.href = "dashboard.html"), 1200);
    return;
  }

  if (editingId) {
    document.getElementById("form-title").textContent = "Edit Problem";
    await loadExisting(editingId);
  } else {
    document.getElementById("form-title").textContent = "Add New Problem";
    renderHints();
    // Suggest the next free problem_number (user app orders the grid,
    // Next/Previous and SEO listing by it).
    const { data } = await sb.from("problems").select("problem_number").order("problem_number", { ascending: false }).limit(1);
    const maxNum = Number(data?.[0]?.problem_number) || 0;
    document.getElementById("problem-number-input").value = maxNum + 1;
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
  if (type === "bug") {
    codeLabel.textContent = "Buggy code (the user will edit and fix this)";
    outputLabel.textContent = "Correct output (compared against the user's fixed-code run)";
  } else {
    codeLabel.textContent = "Code shown to the user (read-only — they predict its output)";
    outputLabel.textContent = "Exact expected output";
  }
}

async function loadExisting(id) {
  const { data: p, error } = await sb.from("problems").select("*").eq("id", id).single();
  if (error || !p) {
    editingBlocked = true; // don't allow saving a bogus "edit"
    showToast("Problem not found", "error");
    setTimeout(() => (window.location.href = "dashboard.html"), 1200);
    return;
  }

  document.getElementById("problem-type").value = p.type;
  document.getElementById("problem-title-input").value = p.title;
  document.getElementById("problem-description").value = p.description || "";
  document.getElementById("problem-difficulty-input").value = p.difficulty;
  // Topic is one of the 12 fixed topics the user app aggregates by.
  const topicSel = document.getElementById("problem-topic-input");
  if ([...topicSel.options].some((o) => o.value === (p.topic || "").toLowerCase())) {
    topicSel.value = (p.topic || "").toLowerCase();
  }
  document.getElementById("problem-number-input").value = p.problem_number ?? "";
  document.getElementById("problem-premium").checked = !!p.is_premium;
  document.getElementById("starter-code").value = p.starter_code || "";
  document.getElementById("expected-output").value = p.expected_output || "";

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

  // NOTE: the user panel has no solution_code column — don't send one,
  // or the save fails. problem_number drives grid order + Next/Previous.
  const numRaw = document.getElementById("problem-number-input").value;
  const payload = {
    type: document.getElementById("problem-type").value,
    title: document.getElementById("problem-title-input").value.trim(),
    description: document.getElementById("problem-description").value.trim(),
    difficulty: document.getElementById("problem-difficulty-input").value,
    topic: document.getElementById("problem-topic-input").value,
    problem_number: numRaw === "" ? null : parseInt(numRaw, 10),
    is_premium: document.getElementById("problem-premium").checked,
    starter_code: document.getElementById("starter-code").value,
    expected_output: document.getElementById("expected-output").value,
    hints: hintValues.filter((h) => h.trim() !== ""),
  };

  // Browser "required" attributes don't catch whitespace-only input.
  if (!payload.title) {
    showToast("Title is required.", "error");
    btn.disabled = false;
    btn.textContent = "Save Problem";
    return;
  }
  if (!payload.starter_code.trim()) {
    showToast("Code is required.", "error");
    btn.disabled = false;
    btn.textContent = "Save Problem";
    return;
  }
  if (!payload.expected_output.trim()) {
    showToast("Expected output is required.", "error");
    btn.disabled = false;
    btn.textContent = "Save Problem";
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
    btn.disabled = false;
    btn.textContent = "Save Problem";
    return;
  }

  showToast(editingId ? "Problem updated" : "Problem added", "success");
  setTimeout(() => (window.location.href = "dashboard.html"), 900);
}
