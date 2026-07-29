// admin-problem-form.js

let editingId = null;
let hintValues = [];

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  editingId = qs("id");

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
  const { data: p, error } = await sb.from("problems").select("*").eq("id", id).single();
  if (error || !p) {
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
  return String(str).replace(/"/g, "&quot;");
}

async function saveProblem(e) {
  e.preventDefault();
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
    solution_code: document.getElementById("solution-code").value,
    expected_output: document.getElementById("expected-output").value,
    hints: hintValues.filter((h) => h.trim() !== ""),
  };

  let error;
  if (editingId) {
    ({ error } = await sb.from("problems").update(payload).eq("id", editingId));
  } else {
    ({ error } = await sb.from("problems").insert(payload));
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
