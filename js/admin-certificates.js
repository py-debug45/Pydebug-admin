// admin-certificates.js — 4-tier verified certificate management & revocation.

let allCerts = [];
let filteredCerts = [];
let certUserMap = {};
let certsPage = 0;

onAdminReady(async () => {
  const admin = await requirePerm("certificates.read");
  if (!admin) return;

  await loadCertificates();

  document.getElementById("cert-search").addEventListener("input", debounce(() => { certsPage = 0; applyCertFilters(); }, 250));
  document.getElementById("cert-filter-tier").addEventListener("change", () => { certsPage = 0; applyCertFilters(); });
  document.getElementById("cert-filter-status").addEventListener("change", () => { certsPage = 0; applyCertFilters(); });
  document.getElementById("refresh-certs-btn").addEventListener("click", loadCertificates);
  document.getElementById("export-certs-btn").addEventListener("click", exportCertificates);
  document.getElementById("quick-verify-btn").addEventListener("click", runQuickVerify);
  document.getElementById("quick-verify-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runQuickVerify(); }
  });

  document.getElementById("cert-modal-close").addEventListener("click", closeCertModal);
  document.getElementById("cert-modal").addEventListener("click", (e) => {
    if (e.target.id === "cert-modal") closeCertModal();
  });
});

async function loadCertificates() {
  const tbody = document.getElementById("certs-tbody");
  tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Loading certificates...</td></tr>`;
  document.getElementById("certs-hint").innerHTML = "";

  let rows = [];
  try {
    rows = await fetchAdminRows("user_certificates", "*", "verify_id");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Could not load certificates.</td></tr>`;
    document.getElementById("certs-hint").innerHTML =
      `<div class="admin-hint">Couldn't read <code>user_certificates</code> (${escapeHtml(err.message)}). Run the latest SQL migration in Supabase.</div>`;
    return;
  }

  rows.sort((a, b) => new Date(b.issued_at || b.created_at || 0) - new Date(a.issued_at || a.created_at || 0));
  allCerts = rows;

  const userIds = [...new Set(allCerts.map((c) => c.user_id).filter(Boolean))];
  certUserMap = {};
  if (userIds.length) {
    const { data: users } = await sb.from("profiles").select("id, display_name, full_name, email").in("id", userIds);
    (users || []).forEach((u) => { certUserMap[u.id] = u; });
  }

  renderCertStats();
  renderCertChart();
  applyCertFilters();
}

function renderCertStats() {
  const total = allCerts.length;
  const revoked = allCerts.filter((c) => !!c.revoked_at).length;
  const active = total - revoked;
  const bronze = allCerts.filter((c) => String(c.tier_id).toLowerCase() === "bronze").length;
  const proTiers = allCerts.filter((c) => ["silver", "gold", "diamond"].includes(String(c.tier_id).toLowerCase())).length;

  document.getElementById("cert-total").textContent = total.toLocaleString("en-IN");
  document.getElementById("cert-active").textContent = active.toLocaleString("en-IN");
  document.getElementById("cert-revoked").textContent = revoked.toLocaleString("en-IN");
  document.getElementById("cert-bronze").textContent = bronze.toLocaleString("en-IN");
  document.getElementById("cert-pro-tiers").textContent = proTiers.toLocaleString("en-IN");
}

function renderCertChart() {
  const tiers = [
    { key: "bronze", label: "Bronze", color: "#e29b56" },
    { key: "silver", label: "Silver", color: "#c0cada" },
    { key: "gold", label: "Gold", color: "#f6c445" },
    { key: "diamond", label: "Diamond", color: "#7ce2ff" },
  ];
  const series = tiers
    .map((t) => ({
      label: t.label,
      value: allCerts.filter((c) => String(c.tier_id).toLowerCase() === t.key).length,
      color: t.color,
    }))
    .filter((s) => s.value > 0);

  document.getElementById("chart-cert-tiers").innerHTML = series.length
    ? svgDonut(series)
    : `<div class="chart-empty">No certificates issued yet</div>`;
}

function applyCertFilters() {
  const search = document.getElementById("cert-search").value.trim().toLowerCase();
  const tier = document.getElementById("cert-filter-tier").value;
  const status = document.getElementById("cert-filter-status").value;

  filteredCerts = allCerts.filter((c) => {
    if (tier !== "all" && String(c.tier_id).toLowerCase() !== tier) return false;
    const isRevoked = !!c.revoked_at;
    if (status === "active" && isRevoked) return false;
    if (status === "revoked" && !isRevoked) return false;
    if (search) {
      const u = certUserMap[c.user_id] || {};
      const hay = `${c.verify_id || ""} ${c.learner_name || ""} ${u.email || ""} ${u.display_name || ""} ${u.full_name || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  renderCertificates();
}

function evidenceSummary(stats) {
  if (!stats || typeof stats !== "object") return "—";
  const parts = [];
  if (stats.solved !== undefined) parts.push(`${stats.solved} solved`);
  if (stats.topics !== undefined) parts.push(`${stats.topics} topics`);
  if (stats.activeDays !== undefined) parts.push(`${stats.activeDays}d active`);
  if (stats.mock_test_score) parts.push(`${stats.mock_test_score}% mock`);
  return parts.join(" · ") || "Snapshot saved";
}

function renderCertificates() {
  const tbody = document.getElementById("certs-tbody");
  const pag = document.getElementById("certs-pagination");

  if (!filteredCerts.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No certificates match your filters.</td></tr>`;
    renderPagination(pag, 0, 0, () => {});
    return;
  }

  const start = certsPage * ADMIN_PAGE_SIZE;
  const slice = filteredCerts.slice(start, start + ADMIN_PAGE_SIZE);

  tbody.innerHTML = slice.map((c) => {
    const u = certUserMap[c.user_id] || {};
    const learner = c.learner_name || u.display_name || u.full_name || "Learner";
    const isRevoked = !!c.revoked_at;
    const vid = escapeHtml(c.verify_id || "");
    const verifyUrl = `https://pydebug.in/certificates?verify=${encodeURIComponent(c.verify_id || "")}`;
    return `<tr>
      <td class="muted" title="${escapeHtml(fmtDateTime(c.issued_at || c.created_at))}">${escapeHtml(timeAgo(c.issued_at || c.created_at))}</td>
      <td class="mono" style="font-size:0.8rem">${vid}</td>
      <td>
        <a href="user-detail.html?id=${encodeURIComponent(c.user_id || "")}">${escapeHtml(learner)}</a>
        <div class="muted" style="font-size:0.74rem">${escapeHtml(u.email || "")}</div>
      </td>
      <td>${tierBadge(c.tier_id)}</td>
      <td class="muted" style="font-size:0.82rem">${escapeHtml(evidenceSummary(c.stats))}</td>
      <td>${isRevoked ? statusBadge("revoked") : statusBadge("active")}</td>
      <td class="row-actions">
        <button class="btn btn--secondary btn--sm" data-inspect-cert="${vid}">Inspect</button>
        <a class="btn btn--secondary btn--sm" href="${verifyUrl}" target="_blank" rel="noopener">Verify ↗</a>
        ${isRevoked
          ? `<span class="muted" style="font-size:0.75rem" title="Revoked ${escapeHtml(fmtDateTime(c.revoked_at))}">Revoked</span>`
          : `<button class="btn btn--danger btn--sm" data-revoke-cert="${vid}">Revoke</button>`}
      </td>
    </tr>`;
  }).join("");

  if (tbody.dataset.bound !== "1") {
    tbody.dataset.bound = "1";
    tbody.addEventListener("click", (event) => {
      const inspectBtn = event.target.closest("button[data-inspect-cert]");
      if (inspectBtn) {
        openCertModal(inspectBtn.dataset.inspectCert);
        return;
      }
      const revokeBtn = event.target.closest("button[data-revoke-cert]");
      if (revokeBtn) revokeCertificate(revokeBtn.dataset.revokeCert, revokeBtn);
    });
  }

  renderPagination(pag, certsPage, filteredCerts.length, (p) => {
    certsPage = p;
    renderCertificates();
  });
}

function runQuickVerify() {
  const raw = document.getElementById("quick-verify-input").value.trim();
  const out = document.getElementById("quick-verify-result");
  if (!raw) {
    out.innerHTML = `<span class="muted">Enter a certificate ID first.</span>`;
    return;
  }
  const match = allCerts.find((c) => String(c.verify_id || "").toLowerCase() === raw.toLowerCase());
  if (!match) {
    out.innerHTML = `${statusBadge("invalid")} <span>No certificate found with ID <code>${escapeHtml(raw)}</code>.</span>`;
    return;
  }
  const state = match.revoked_at ? statusBadge("revoked") : statusBadge("active");
  out.innerHTML = `${state} ${tierBadge(match.tier_id)} Issued to <strong>${escapeHtml(match.learner_name || "Learner")}</strong> on ${escapeHtml(fmtDateTime(match.issued_at))} · <button type="button" class="btn btn--secondary btn--sm" id="quick-open-modal">Inspect snapshot</button>`;
  document.getElementById("quick-open-modal")?.addEventListener("click", () => openCertModal(match.verify_id));
}

function openCertModal(verifyId) {
  const c = allCerts.find((x) => x.verify_id === verifyId);
  if (!c) return;
  const u = certUserMap[c.user_id] || {};
  const st = c.stats || {};
  document.getElementById("cert-modal-title").textContent = `${c.verify_id}`;
  document.getElementById("cert-modal-meta").innerHTML =
    `${tierBadge(c.tier_id)} ${c.revoked_at ? statusBadge("revoked") : statusBadge("active")} · ` +
    `Learner: <strong>${escapeHtml(c.learner_name || u.display_name || "—")}</strong> (${escapeHtml(u.email || c.user_id || "")}) · ` +
    `Issued: ${escapeHtml(fmtDateTime(c.issued_at))}` +
    (c.revoked_at ? ` · Revoked: ${escapeHtml(fmtDateTime(c.revoked_at))}` : "");

  const metrics = [
    ["Problems solved", st.solved ?? "—"],
    ["Bug fixes", st.bugSolved ?? "—"],
    ["Output predictions", st.predictionSolved ?? "—"],
    ["Topics covered", st.topics !== undefined ? `${st.topics}/${st.totalTopics || 12}` : "—"],
    ["Distinct active days", st.activeDays ?? "—"],
    ["Streak at issue", st.streak ?? "—"],
    ["Mock score", st.mock_test_score ? `${st.mock_test_score}%` : "—"],
    ["Mock percentile", st.mock_test_percentile ? `${st.mock_test_percentile}th` : "—"],
  ];
  document.getElementById("cert-modal-kpis").innerHTML = metrics
    .map(([k, v]) => `<div class="kv-box"><span>${escapeHtml(k)}</span><strong>${escapeHtml(String(v))}</strong></div>`)
    .join("");
  document.getElementById("cert-modal-json").textContent = JSON.stringify(c, null, 2);
  document.getElementById("cert-modal").classList.add("is-open");
}

function closeCertModal() {
  document.getElementById("cert-modal").classList.remove("is-open");
}

async function revokeCertificate(verifyId, btn) {
  if (!ensureCan("certificates.write")) return;
  const reason = prompt(
    `IRREVERSIBLE ACTION:\nRevoking certificate "${verifyId}" permanently marks it as REVOKED on public verification.\n\nOptional reason for audit log:`,
    "Policy / integrity violation"
  );
  if (reason === null) return;
  if (!confirm(`Confirm permanent revocation of ${verifyId}? This cannot be undone.`)) return;

  btn.disabled = true;
  const { error } = await sb.rpc("admin_revoke_certificate", {
    target_verify_id: verifyId,
    revoke_reason: reason.trim() || null,
  });
  if (error) {
    showToast("Revoke failed: " + error.message, "error");
    btn.disabled = false;
    return;
  }
  showToast(`Certificate ${verifyId} revoked`, "success");
  await loadCertificates();
}

function exportCertificates() {
  downloadCSV("pydebug-certificates.csv", filteredCerts.map((c) => {
    const u = certUserMap[c.user_id] || {};
    const st = c.stats || {};
    return {
      verify_id: c.verify_id,
      tier: c.tier_id,
      status: c.revoked_at ? "revoked" : "active",
      learner_name: c.learner_name || u.display_name || "",
      email: u.email || "",
      issued_at: c.issued_at,
      revoked_at: c.revoked_at || "",
      solved: st.solved ?? "",
      topics: st.topics ?? "",
      active_days: st.activeDays ?? "",
      mock_score: st.mock_test_score ?? "",
    };
  }));
}
