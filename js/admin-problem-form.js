// admin-problem-form.js

let editingId = null;
let editingBlocked = false; // true when the problem to edit couldn't be loaded — saving is disabled
let hintValues = [];
let formDirty = false;
let saving = false;

const VALID_TYPES = ["bug", "question"];
const VALID_DIFFICULTIES = ["easy", "medium", "hard"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_ID_RE = /^\d+$/;

// The problems table may use a uuid **or** a bigint/serial primary key. The
// previous UUID-only check made "Edit" permanently impossible on integer-id
// schemas — it bounced straight back to the dashboard.
function isValidProblemId(id) {
  return UUID_RE.test(id) || INT_ID_RE.test(id);
}

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  editingId = qs("id");

  // Guard against malformed ids (problem-form.html?id=<junk>) — previously the
  // page stayed in "Edit" mode and Save would fail/behave oddly.
  if (editingId && !isValidProblemId(editingId)) {
    editingBlocked = true;
    showToast("Invalid problem id — redirecting to dashboard.", "error");
    setTimeout(() => (window.location.href = "dashboard.html"), 1200);
    return;
  }

  const form = document.getElementById("problem-form");
  const titleEl = document.getElementById("form-title");

  if (editingId) {
    if (titleEl) titleEl.textContent = "Edit Problem";
    document.title = "Edit Problem — PyDebug Admin";
    await loadExisting(editingId);
  } else {
    if (titleEl) titleEl.textContent = "Add New Problem";
    document.title = "Add Problem — PyDebug Admin";
    renderHints();
  }

  const addHintBtn = document.getElementById("add-hint-btn");
  if (addHintBtn) {
    addHintBtn.addEventListener("click", () => {
      hintValues.push("");
      formDirty = true;
      renderHints({ focusLast: true });
    });
  }

  if (form) {
    form.addEventListener("submit", saveProblem);
    form.addEventListener("input", () => {
      formDirty = true;
    });
  }

  const typeEl = document.getElementById("problem-type");
  if (typeEl) typeEl.addEventListener("change", updateFieldLabels);
  updateFieldLabels();

  // Warn before losing unsaved edits (accidental back button / nav click).
  window.addEventListener("beforeunload", (e) => {
    if (!formDirty || saving || editingBlocked) return;
    e.preventDefault();
    e.returnValue = "";
  });
});

function updateFieldLabels() {
  const typeEl = document.getElementById("problem-type");
  if (!typeEl) return;
  const type = typeEl.value;
  const codeLabel = document.getElementById("starter-code-label");
  const outputLabel = document.getElementById("expected-output-label");
  const solutionField = document.getElementById("solution-code-field");

  if (type === "bug") {
    if (codeLabel) codeLabel.textContent = "Buggy code (the user will edit and fix this)";
    if (outputLabel) outputLabel.textContent = "Correct output (compared against the user's fixed-code run)";
  } else {
    if (codeLabel) codeLabel.textContent = "Code shown to the user (read-only — they predict its output)";
    if (outputLabel) outputLabel.textContent = "Exact expected output";
  }

  // Solution code is only used by "Use a Hint" on bug problems. It used to
  // stay visible for Predict-Output problems, which was confusing and let
  // admins save data that nothing ever reads.
  if (solutionField) solutionField.hidden = type !== "bug";
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
    const form = document.getElementById("problem-form");
    if (form) {
      form.querySelectorAll("input, select, textarea, button").forEach((el) => (el.disabled = true));
    }
    showToast(
      error && error.code !== "PGRST116" ? "Could not load problem: " + errorText(error) : "Problem not found",
      "error"
    );
    setTimeout(() => (window.location.href = "dashboard.html"), 1500);
    return;
  }

  // Fall back to a valid option if the stored value isn't one the <select>
  // offers — otherwise the select shows blank and Save writes an empty string.
  setValue("problem-type", VALID_TYPES.includes(p.type) ? p.type : "bug");
  setValue("problem-difficulty-input", VALID_DIFFICULTIES.includes(p.difficulty) ? p.difficulty : "easy");
  setValue("problem-title-input", p.title || "");
  setValue("problem-description", p.description || "");
  setValue("problem-topic-input", p.topic || "");
  setValue("starter-code", p.starter_code || "");
  setValue("solution-code", p.solution_code || "");
  setValue("expected-output", p.expected_output || "");

  const premiumEl = document.getElementById("problem-premium");
  if (premiumEl) premiumEl.checked = !!p.is_premium;

  hintValues = normaliseHints(p.hints);
  renderHints();
  updateFieldLabels();

  // Programmatic population isn't a user edit.
  formDirty = false;
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

// `hints` may come back as a JSON array, a JSON string, or null depending on
// how the column was created. Previously anything but a real array was dropped
// on the floor, silently wiping the hints on the next save.
function normaliseHints(hints) {
  if (Array.isArray(hints)) return hints.map((h) => (h == null ? "" : String(h)));
  if (typeof hints === "string" && hints.trim() !== "") {
    try {
      const parsed = JSON.parse(hints);
      if (Array.isArray(parsed)) return parsed.map((h) => (h == null ? "" : String(h)));
    } catch (err) {
      /* not JSON — treat the whole string as one hint */
    }
    return [hints];
  }
  return [];
}

function renderHints({ focusLast = false } = {}) {
  const container = document.getElementById("hints-container");
  if (!container) return;
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
      formDirty = true;
      renderHints();
    });

    row.append(input, removeBtn);
    container.appendChild(row);
  });

  if (focusLast) {
    const inputs = container.querySelectorAll(".hint-input");
    if (inputs.length) inputs[inputs.length - 1].focus();
  }
}

async function saveProblem(e) {
  e.preventDefault();
  if (editingBlocked || saving) return;

  const btn = e.target.querySelector("button[type=submit]");
  const finish = (message) => {
    saving = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save Problem";
    }
    if (message) showToast(message, "error");
  };

  saving = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving...";
  }

  const type = document.getElementById("problem-type").value;
  const difficulty = document.getElementById("problem-difficulty-input").value;

  const payload = {
    type: VALID_TYPES.includes(type) ? type : "bug",
    title: document.getElementById("problem-title-input").value.trim(),
    description: document.getElementById("problem-description").value.trim(),
    difficulty: VALID_DIFFICULTIES.includes(difficulty) ? difficulty : "easy",
    topic: document.getElementById("problem-topic-input").value.trim(),
    is_premium: document.getElementById("problem-premium").checked,
    starter_code: document.getElementById("starter-code").value,
    // Solution code only applies to bug problems — don't persist stale text
    // that the hidden field may still be holding from a type switch.
    solution_code: type === "bug" ? document.getElementById("solution-code").value : "",
    expected_output: document.getElementById("expected-output").value,
    hints: hintValues.map((h) => h.trim()).filter((h) => h !== ""),
  };

  // Browser "required" attributes don't catch whitespace-only input.
  if (!payload.title) return finish("Title is required.");
  if (!payload.starter_code.trim()) return finish("Code is required.");
  if (!payload.expected_output.trim()) return finish("Expected output is required.");

  let error = null;
  let data = null;
  try {
    if (editingId) {
      ({ data, error } = await sb.from("problems").update(payload).eq("id", editingId).select("id"));
    } else {
      ({ data, error } = await sb.from("problems").insert(payload).select("id"));
    }
  } catch (err) {
    error = err;
  }

  if (error) return finish("Could not save: " + errorText(error));

  // An RLS policy can make an update match zero rows without erroring — that
  // used to show "Problem updated" while nothing had actually changed.
  if (!data || data.length === 0) {
    return finish("Nothing was saved — check the admin RLS policies (README step 1).");
  }

  saving = true;
  formDirty = false; // let the page navigate without the unsaved-changes prompt
  showToast(editingId ? "Problem updated" : "Problem added", "success");
  setTimeout(() => (window.location.href = "dashboard.html"), 900);
}
