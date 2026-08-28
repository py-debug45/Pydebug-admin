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
  let p = null;
  let error = null;
  try {
    ({ data: p, error } = await sb.from("problems").select("*").eq("id", id).single());
  } catch (err) {
    error = err;
  }

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
  document.getElementById("problem-topic-input").value = p.topic || "";
  document.getElementById("problem-premium").checked = !!p.is_premium;
  document.getElementById("starter-code").value = p.starter_code || "";
  document.getElementById("solution-code").value = p.solution_code || "";
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

    const input = document.createElement("input");
    input.type = "text";
    input.className = "hint-input";
    input.placeholder = `Hint ${i + 1}`;
    input.value = value;
    input.addEventListener("input", () => {
      hintValues[i] = input.value;
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn btn--secondary btn--sm remove-hint-btn";
    removeBtn.textContent = "✕";
    removeBtn.setAttribute("aria-label", `Remove hint ${i + 1}`);
    removeBtn.addEventListener("click", () => {
      hintValues.splice(i, 1);
      renderHints();
    });

    row.append(input, removeBtn);
    container.appendChild(row);
  });
}

async function saveProblem(e) {
  e.preventDefault();
  if (editingBlocked) return;

  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Saving...";

  const payload = {
    type: document.getElementById("problem-type").value,
    title: document.getElementById("problem-title-input").value.trim(),
    description: document.getElementById("problem-description").value.trim(),
    difficulty: document.getElementById("problem-difficulty-input").value,
    topic: document.getElementById("problem-topic-input").value.trim(),
    is_premium: document.getElementById("problem-premium").checked,
    starter_code: document.getElementById("starter-code").value,
    solution_code: document.getElementById("solution-code").value,
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
