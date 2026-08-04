(function () {
  "use strict";

  const state = {
    token: null,
    pages: [],
    pageIndex: 0,
    box: { xPct: 0.1, yPct: 0.75, wPct: 0.25, hPct: 0.09 }, // fractions of page
    newSigTab: "draw",
    signatures: [],
    selectedSignatureId: null,
    dragMode: null, // 'move' | 'resize' | null
    dragStart: null,
  };

  const el = (id) => document.getElementById(id);

  const uploadStatus = el("upload-status");
  const librarySection = el("library-section");
  const placeSection = el("place-section");
  const cryptoSection = el("crypto-section");
  const submitSection = el("submit-section");
  const pageSelect = el("page-select");
  const pageImage = el("page-image");
  const previewContainer = el("preview-container");
  const signatureGrid = el("signature-grid");
  const libraryEmpty = el("library-empty");
  const addSignaturePanel = el("add-signature-panel");
  const libraryStatus = el("library-status");
  const dropzone = el("dropzone");
  const pdfInput = el("pdf-input");

  let dragSigEl = null; // the draggable overlay element, created lazily

  // ---------- 1. Upload PDF ----------
  pdfInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleUpload(file);
  });

  ["dragover", "dragenter"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "dragend"].forEach((evt) =>
    dropzone.addEventListener(evt, () => dropzone.classList.remove("dragover"))
  );
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  });

  async function handleUpload(file) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      uploadStatus.textContent = "Please choose a .pdf file.";
      uploadStatus.className = "status error";
      return;
    }

    uploadStatus.textContent = "Uploading & rendering previews...";
    uploadStatus.className = "status";

    const formData = new FormData();
    formData.append("pdf", file);

    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");

      state.token = data.token;
      state.pages = data.pages;
      state.pageIndex = 0;

      uploadStatus.textContent = `Loaded "${file.name}" (${data.pages.length} page${data.pages.length > 1 ? "s" : ""})`;
      uploadStatus.className = "status success";

      populatePageSelect();
      showPage(0);
      [librarySection, placeSection, cryptoSection, submitSection].forEach((s) => s.classList.remove("hidden"));
      loadSignatureLibrary();
    } catch (err) {
      uploadStatus.textContent = err.message;
      uploadStatus.className = "status error";
    }
  }

  function populatePageSelect() {
    pageSelect.innerHTML = "";
    state.pages.forEach((p, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = `Page ${i + 1}`;
      pageSelect.appendChild(opt);
    });
  }

  pageSelect.addEventListener("change", (e) => showPage(parseInt(e.target.value, 10)));

  function showPage(index) {
    state.pageIndex = index;
    pageSelect.value = String(index);
    const page = state.pages[index];
    pageImage.src = `data:image/png;base64,${page.image_base64}`;
    pageImage.onload = () => renderDragSig();
  }

  // ---------- 2. Signature library ----------
  async function loadSignatureLibrary() {
    try {
      const res = await fetch("/api/signatures");
      const data = await res.json();
      state.signatures = data.signatures || [];
      renderLibrary();
    } catch (err) {
      libraryStatus.textContent = "Could not load saved signatures.";
      libraryStatus.className = "status error";
    }
  }

  function renderLibrary() {
    signatureGrid.innerHTML = "";
    libraryEmpty.classList.toggle("hidden", state.signatures.length > 0);

    state.signatures.forEach((sig) => {
      const card = document.createElement("div");
      card.className = "sig-card" + (sig.id === state.selectedSignatureId ? " selected" : "");
      card.title = sig.label;

      const img = document.createElement("img");
      img.src = `data:image/png;base64,${sig.image_base64}`;
      card.appendChild(img);

      const label = document.createElement("div");
      label.className = "sig-label";
      label.textContent = sig.label;
      card.appendChild(label);

      const del = document.createElement("button");
      del.className = "sig-delete";
      del.textContent = "\u00D7";
      del.title = "Delete";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSignature(sig.id);
      });
      card.appendChild(del);

      card.addEventListener("click", () => selectSignature(sig.id));
      signatureGrid.appendChild(card);
    });
  }

  function selectSignature(id) {
    state.selectedSignatureId = id;
    renderLibrary();
    renderDragSig();
  }

  async function deleteSignature(id) {
    if (!confirm("Delete this saved signature?")) return;
    try {
      await fetch(`/api/signatures/${id}`, { method: "DELETE" });
      state.signatures = state.signatures.filter((s) => s.id !== id);
      if (state.selectedSignatureId === id) {
        state.selectedSignatureId = null;
        renderDragSig();
      }
      renderLibrary();
    } catch (err) {
      libraryStatus.textContent = "Could not delete signature.";
      libraryStatus.className = "status error";
    }
  }

  el("add-signature-toggle").addEventListener("click", () => {
    addSignaturePanel.classList.toggle("hidden");
  });

  document.querySelectorAll("#add-signature-panel .tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#add-signature-panel .tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.newSigTab = btn.dataset.tab;
      ["draw", "type", "upload"].forEach((t) =>
        el(`tab-${t}`).classList.toggle("hidden", state.newSigTab !== t)
      );
    });
  });

  // Draw tab
  const canvas = el("sig-canvas");
  const ctx = canvas.getContext("2d");
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#111";
  let drawing = false;
  let hasStroke = false;

  function canvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const point = e.touches ? e.touches[0] : e;
    return {
      x: (point.clientX - rect.left) * scaleX,
      y: (point.clientY - rect.top) * scaleY,
    };
  }

  function startDraw(e) {
    drawing = true;
    hasStroke = true;
    const { x, y } = canvasPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    e.preventDefault();
  }

  function moveDraw(e) {
    if (!drawing) return;
    const { x, y } = canvasPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    e.preventDefault();
  }

  function endDraw() {
    drawing = false;
  }

  canvas.addEventListener("mousedown", startDraw);
  canvas.addEventListener("mousemove", moveDraw);
  canvas.addEventListener("mouseup", endDraw);
  canvas.addEventListener("mouseleave", endDraw);
  canvas.addEventListener("touchstart", startDraw);
  canvas.addEventListener("touchmove", moveDraw);
  canvas.addEventListener("touchend", endDraw);

  el("clear-canvas").addEventListener("click", () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasStroke = false;
  });

  // Type tab
  el("typed-signature").addEventListener("input", (e) => {
    el("typed-preview").textContent = e.target.value;
  });

  // Upload tab
  el("upload-signature-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      el("upload-signature-preview").src = reader.result;
      el("upload-signature-preview-wrap").classList.remove("hidden");
    };
    reader.readAsDataURL(file);
  });

  // Save to library
  el("save-signature-btn").addEventListener("click", async () => {
    libraryStatus.textContent = "Saving...";
    libraryStatus.className = "status";

    const label = el("signature-label").value.trim();

    try {
      let res;
      if (state.newSigTab === "draw") {
        if (!hasStroke) throw new Error("Draw a signature first.");
        res = await fetch("/api/signatures", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "drawn", image_base64: canvas.toDataURL("image/png"), label }),
        });
      } else if (state.newSigTab === "type") {
        const text = el("typed-signature").value.trim();
        if (!text) throw new Error("Type a signature first.");
        res = await fetch("/api/signatures", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "typed", text, label }),
        });
      } else {
        const file = el("upload-signature-input").files[0];
        if (!file) throw new Error("Choose an image file first.");
        const formData = new FormData();
        formData.append("file", file);
        formData.append("label", label);
        res = await fetch("/api/signatures", { method: "POST", body: formData });
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save signature");

      state.signatures.unshift(data);
      state.selectedSignatureId = data.id;
      renderLibrary();
      renderDragSig();

      // reset the add-signature panel
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasStroke = false;
      el("typed-signature").value = "";
      el("typed-preview").textContent = "";
      el("upload-signature-input").value = "";
      el("upload-signature-preview-wrap").classList.add("hidden");
      el("signature-label").value = "";
      addSignaturePanel.classList.add("hidden");

      libraryStatus.textContent = "Saved.";
      libraryStatus.className = "status success";
    } catch (err) {
      libraryStatus.textContent = err.message;
      libraryStatus.className = "status error";
    }
  });

  // ---------- 3. Drag-and-drop placement ----------
  function ensureDragSigEl() {
    if (dragSigEl) return dragSigEl;
    dragSigEl = document.createElement("div");
    dragSigEl.className = "drag-sig";

    const img = document.createElement("img");
    dragSigEl.appendChild(img);

    const handle = document.createElement("div");
    handle.className = "resize-handle";
    dragSigEl.appendChild(handle);

    dragSigEl.addEventListener("pointerdown", (e) => {
      if (e.target === handle) {
        state.dragMode = "resize";
      } else {
        state.dragMode = "move";
      }
      state.dragStart = {
        clientX: e.clientX,
        clientY: e.clientY,
        box: { ...state.box },
      };
      dragSigEl.classList.add("dragging");
      dragSigEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    dragSigEl.addEventListener("pointermove", (e) => {
      if (!state.dragMode) return;
      const rect = pageImage.getBoundingClientRect();
      if (!rect.width) return;
      const dxPct = (e.clientX - state.dragStart.clientX) / rect.width;
      const dyPct = (e.clientY - state.dragStart.clientY) / rect.height;

      if (state.dragMode === "move") {
        state.box.xPct = clamp(state.dragStart.box.xPct + dxPct, 0, 1 - state.box.wPct);
        state.box.yPct = clamp(state.dragStart.box.yPct + dyPct, 0, 1 - state.box.hPct);
      } else if (state.dragMode === "resize") {
        const minW = 0.03;
        const minH = 0.02;
        const maxW = 1 - state.box.xPct;
        const maxH = 1 - state.box.yPct;
        state.box.wPct = clamp(state.dragStart.box.wPct + dxPct, minW, maxW);
        state.box.hPct = clamp(state.dragStart.box.hPct + dyPct, minH, maxH);
      }
      renderDragSig();
    });

    ["pointerup", "pointercancel"].forEach((evt) =>
      dragSigEl.addEventListener(evt, () => {
        state.dragMode = null;
        dragSigEl.classList.remove("dragging");
      })
    );

    previewContainer.appendChild(dragSigEl);
    return dragSigEl;
  }

  function renderDragSig() {
    const sig = state.signatures.find((s) => s.id === state.selectedSignatureId);
    if (!sig || !pageImage.src) {
      if (dragSigEl) dragSigEl.classList.add("hidden");
      return;
    }

    const node = ensureDragSigEl();
    node.classList.remove("hidden");
    const img = node.querySelector("img");
    img.src = `data:image/png;base64,${sig.image_base64}`;

    const rect = pageImage.getBoundingClientRect();
    if (!rect.width) return;
    node.style.left = `${state.box.xPct * rect.width}px`;
    node.style.top = `${state.box.yPct * rect.height}px`;
    node.style.width = `${state.box.wPct * rect.width}px`;
    node.style.height = `${state.box.hPct * rect.height}px`;
  }

  window.addEventListener("resize", renderDragSig);

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  // ---------- 4. Crypto signing toggle ----------
  el("crypto-checkbox").addEventListener("change", (e) => {
    el("crypto-fields").classList.toggle("hidden", !e.target.checked);
  });

  // ---------- 5. Submit ----------
  el("sign-btn").addEventListener("click", async () => {
    const signStatus = el("sign-status");
    signStatus.className = "status";

    if (!state.token) {
      signStatus.textContent = "Upload a PDF first.";
      signStatus.className = "status error";
      return;
    }
    if (!state.selectedSignatureId) {
      signStatus.textContent = "Pick a signature from your library first (or add a new one).";
      signStatus.className = "status error";
      return;
    }

    const payload = {
      token: state.token,
      page_index: state.pageIndex,
      x_pct: state.box.xPct,
      y_pct: state.box.yPct,
      w_pct: state.box.wPct,
      h_pct: state.box.hPct,
      saved_signature_id: state.selectedSignatureId,
      crypto_sign: el("crypto-checkbox").checked,
      signer_name: el("signer-name").value,
      reason: el("signer-reason").value,
      location: el("signer-location").value,
    };

    signStatus.textContent = "Signing PDF...";

    try {
      const res = await fetch("/api/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Signing failed");
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "signed.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      signStatus.textContent = "Done! Your signed PDF has downloaded.";
      signStatus.className = "status success";
    } catch (err) {
      signStatus.textContent = err.message;
      signStatus.className = "status error";
    }
  });
  // ---------- Tools view ----------
  const signView = el("sign-view");
  const toolsView = el("tools-view");
  const mypdfsView = el("mypdfs-view");
  const docsView = el("docs-view");
  const viewMap = { sign: signView, tools: toolsView, mypdfs: mypdfsView, docs: docsView };

  document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".view-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const view = tab.dataset.view;
      Object.entries(viewMap).forEach(([name, node]) => node.classList.toggle("hidden", name !== view));
      if (view === "mypdfs") loadMyPdfs();
    });
  });

  document.querySelectorAll(".tool-card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".tool-card").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      document.querySelectorAll(".tool-panel").forEach((panel) => panel.classList.add("hidden"));
      el(`tool-panel-${card.dataset.tool}`).classList.remove("hidden");
    });
  });

  function setToolStatus(id, message, kind) {
    const node = el(id);
    node.textContent = message;
    node.className = "status" + (kind ? ` ${kind}` : "");
  }

  async function downloadToolResult(res, fallbackName) {
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Request failed");
    }
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : fallbackName;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return res;
  }

  // Merge
  el("merge-btn").addEventListener("click", async () => {
    const files = el("merge-files").files;
    if (files.length < 2) {
      setToolStatus("merge-status", "Choose at least two PDFs.", "error");
      return;
    }
    setToolStatus("merge-status", "Merging...", "");
    const formData = new FormData();
    Array.from(files).forEach((f) => formData.append("pdfs", f));
    try {
      const res = await fetch("/api/tools/merge", { method: "POST", body: formData });
      await downloadToolResult(res, "merged.pdf");
      setToolStatus("merge-status", "Done! Downloaded merged.pdf", "success");
    } catch (err) {
      setToolStatus("merge-status", err.message, "error");
    }
  });

  // Extract
  el("extract-btn").addEventListener("click", async () => {
    const file = el("extract-file").files[0];
    const pages = el("extract-pages").value.trim();
    if (!file) return setToolStatus("extract-status", "Choose a PDF first.", "error");
    if (!pages) return setToolStatus("extract-status", "Enter which pages to extract.", "error");

    setToolStatus("extract-status", "Extracting...", "");
    const formData = new FormData();
    formData.append("pdf", file);
    formData.append("pages", pages);
    try {
      const res = await fetch("/api/tools/extract", { method: "POST", body: formData });
      await downloadToolResult(res, "extracted.pdf");
      setToolStatus("extract-status", "Done! Downloaded extracted.pdf", "success");
    } catch (err) {
      setToolStatus("extract-status", err.message, "error");
    }
  });

  // Compress
  el("compress-btn").addEventListener("click", async () => {
    const file = el("compress-file").files[0];
    if (!file) return setToolStatus("compress-status", "Choose a PDF first.", "error");

    setToolStatus("compress-status", "Compressing...", "");
    const formData = new FormData();
    formData.append("pdf", file);
    formData.append("quality", el("compress-quality").value);
    try {
      const res = await fetch("/api/tools/compress", { method: "POST", body: formData });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Compression failed");
      }
      const before = parseInt(res.headers.get("X-Original-Size") || "0", 10);
      const after = parseInt(res.headers.get("X-Compressed-Size") || "0", 10);
      await downloadToolResult(res, "compressed.pdf");
      const pct = before ? Math.round((1 - after / before) * 100) : 0;
      setToolStatus(
        "compress-status",
        `Done! ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB (${pct}% smaller)`,
        "success"
      );
    } catch (err) {
      setToolStatus("compress-status", err.message, "error");
    }
  });

  // Fill form
  let fillToken = null;
  let fillFields = [];

  el("fill-detect-btn").addEventListener("click", async () => {
    const file = el("fill-file").files[0];
    if (!file) return setToolStatus("fill-status", "Choose a PDF first.", "error");

    setToolStatus("fill-status", "Scanning for form fields...", "");
    const formData = new FormData();
    formData.append("pdf", file);
    try {
      const res = await fetch("/api/tools/form-fields", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not read form fields");

      fillToken = data.token;
      fillFields = data.fields;
      renderFillFields();
      el("fill-btn").classList.remove("hidden");
      setToolStatus("fill-status", `Found ${fillFields.length} field${fillFields.length === 1 ? "" : "s"}.`, "success");
    } catch (err) {
      setToolStatus("fill-status", err.message, "error");
      el("fill-btn").classList.add("hidden");
    }
  });

  function renderFillFields() {
    const container = el("fill-fields-container");
    container.innerHTML = "";
    fillFields.forEach((field) => {
      const row = document.createElement("div");
      row.className = "form-field-row";

      const label = document.createElement("label");
      label.textContent = field.name;
      label.title = field.name;
      row.appendChild(label);

      let input;
      if (field.type === "checkbox") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = field.value === "/Yes" || field.value === "/On";
      } else if (field.type === "choice" && field.options) {
        input = document.createElement("select");
        field.options.forEach((opt) => {
          const o = document.createElement("option");
          o.value = opt;
          o.textContent = opt;
          input.appendChild(o);
        });
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.value = field.value || "";
      }
      input.dataset.fieldName = field.name;
      input.dataset.fieldType = field.type;
      row.appendChild(input);
      container.appendChild(row);
    });
  }

  el("fill-btn").addEventListener("click", async () => {
    if (!fillToken) return;
    const values = {};
    document.querySelectorAll("#fill-fields-container [data-field-name]").forEach((input) => {
      if (input.dataset.fieldType === "checkbox") {
        values[input.dataset.fieldName] = input.checked ? "/Yes" : "/Off";
      } else {
        values[input.dataset.fieldName] = input.value;
      }
    });

    setToolStatus("fill-status", "Filling...", "");
    try {
      const res = await fetch("/api/tools/fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: fillToken, values }),
      });
      await downloadToolResult(res, "filled.pdf");
      setToolStatus("fill-status", "Done! Downloaded filled.pdf", "success");
    } catch (err) {
      setToolStatus("fill-status", err.message, "error");
    }
  });

  // Convert to Word
  el("toword-btn").addEventListener("click", async () => {
    const file = el("toword-file").files[0];
    if (!file) return setToolStatus("toword-status", "Choose a PDF first.", "error");

    setToolStatus("toword-status", "Converting...", "");
    const formData = new FormData();
    formData.append("pdf", file);
    try {
      const res = await fetch("/api/tools/to-word", { method: "POST", body: formData });
      await downloadToolResult(res, "converted.docx");
      setToolStatus("toword-status", "Done! Downloaded converted.docx", "success");
    } catch (err) {
      setToolStatus("toword-status", err.message, "error");
    }
  });

  // Password protect
  el("protect-btn").addEventListener("click", async () => {
    const file = el("protect-file").files[0];
    const password = el("protect-password").value;
    if (!file) return setToolStatus("protect-status", "Choose a PDF first.", "error");
    if (!password) return setToolStatus("protect-status", "Enter a password.", "error");

    setToolStatus("protect-status", "Encrypting...", "");
    const formData = new FormData();
    formData.append("pdf", file);
    formData.append("user_password", password);
    try {
      const res = await fetch("/api/tools/protect", { method: "POST", body: formData });
      await downloadToolResult(res, "protected.pdf");
      setToolStatus("protect-status", "Done! Downloaded protected.pdf", "success");
    } catch (err) {
      setToolStatus("protect-status", err.message, "error");
    }
  });

  // Password remove
  el("unlock-btn").addEventListener("click", async () => {
    const file = el("unlock-file").files[0];
    const password = el("unlock-password").value;
    if (!file) return setToolStatus("unlock-status", "Choose a PDF first.", "error");
    if (!password) return setToolStatus("unlock-status", "Enter the current password.", "error");

    setToolStatus("unlock-status", "Removing password...", "");
    const formData = new FormData();
    formData.append("pdf", file);
    formData.append("password", password);
    try {
      const res = await fetch("/api/tools/unlock", { method: "POST", body: formData });
      await downloadToolResult(res, "unlocked.pdf");
      setToolStatus("unlock-status", "Done! Downloaded unlocked.pdf", "success");
    } catch (err) {
      setToolStatus("unlock-status", err.message, "error");
    }
  });
  // ---------- My PDFs ----------
  async function loadMyPdfs() {
    const container = el("mypdfs-list");
    const emptyMsg = el("mypdfs-empty");
    try {
      const res = await fetch("/api/pdfs");
      const data = await res.json();
      renderMyPdfs(data.pdfs || [], container, emptyMsg, true);
    } catch (err) {
      container.innerHTML = "";
      emptyMsg.textContent = "Could not load saved PDFs.";
      emptyMsg.classList.remove("hidden");
    }
  }

  function formatSize(bytes) {
    if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function formatDate(unixSeconds) {
    return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function renderMyPdfs(pdfs, container, emptyMsg, withSignAgain) {
    container.innerHTML = "";
    emptyMsg.classList.toggle("hidden", pdfs.length > 0);

    pdfs.forEach((pdf) => {
      const row = document.createElement("div");
      row.className = "mypdfs-row";

      const icon = document.createElement("span");
      icon.className = "mypdfs-icon";
      icon.textContent = "\u{1F4C4}";
      row.appendChild(icon);

      const info = document.createElement("div");
      info.className = "mypdfs-info";
      const name = document.createElement("div");
      name.className = "mypdfs-name";
      name.textContent = pdf.filename;
      name.title = pdf.filename;
      const meta = document.createElement("div");
      meta.className = "mypdfs-meta";
      meta.textContent = `${formatSize(pdf.size)} \u00B7 ${formatDate(pdf.created_at)}`;
      info.appendChild(name);
      info.appendChild(meta);
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "mypdfs-actions";

      const downloadBtn = document.createElement("button");
      downloadBtn.className = "secondary";
      downloadBtn.textContent = "Download";
      downloadBtn.addEventListener("click", () => {
        window.location.href = `/api/pdfs/${pdf.id}/download`;
      });
      actions.appendChild(downloadBtn);

      if (withSignAgain) {
        const signBtn = document.createElement("button");
        signBtn.className = "secondary";
        signBtn.textContent = "Sign again";
        signBtn.addEventListener("click", () => loadSavedPdfForSigning(pdf.id));
        actions.appendChild(signBtn);
      }

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "secondary";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", async () => {
        if (!confirm(`Delete "${pdf.filename}"?`)) return;
        await fetch(`/api/pdfs/${pdf.id}`, { method: "DELETE" });
        row.remove();
        if (container.children.length === 0) emptyMsg.classList.remove("hidden");
      });
      actions.appendChild(deleteBtn);

      row.appendChild(actions);
      container.appendChild(row);
    });
  }

  // ---------- Pick a saved PDF from the Sign tab ----------
  el("pick-saved-pdf-btn").addEventListener("click", async () => {
    const picker = el("saved-pdf-picker");
    picker.classList.toggle("hidden");
    if (picker.classList.contains("hidden")) return;

    const container = el("saved-pdf-picker-list");
    const emptyMsg = el("saved-pdf-picker-empty");
    try {
      const res = await fetch("/api/pdfs");
      const data = await res.json();
      renderMyPdfs(data.pdfs || [], container, emptyMsg, false);
      // Clicking "Download" in this compact picker isn't the point - repurpose
      // rows to load the PDF into the signing flow instead.
      container.querySelectorAll(".mypdfs-row").forEach((row, i) => {
        row.style.cursor = "pointer";
        row.addEventListener("click", (e) => {
          if (e.target.tagName === "BUTTON") return;
          loadSavedPdfForSigning(data.pdfs[i].id);
          picker.classList.add("hidden");
        });
      });
    } catch (err) {
      emptyMsg.textContent = "Could not load saved PDFs.";
      emptyMsg.classList.remove("hidden");
    }
  });

  async function loadSavedPdfForSigning(pdfId) {
    uploadStatus.textContent = "Loading...";
    uploadStatus.className = "status";
    try {
      const res = await fetch(`/api/pdfs/${pdfId}/load-for-signing`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load PDF");

      state.token = data.token;
      state.pages = data.pages;
      state.pageIndex = 0;

      uploadStatus.textContent = `Loaded "${data.filename}" (${data.pages.length} page${data.pages.length > 1 ? "s" : ""})`;
      uploadStatus.className = "status success";

      populatePageSelect();
      showPage(0);
      [librarySection, placeSection, cryptoSection, submitSection].forEach((s) => s.classList.remove("hidden"));
      loadSignatureLibrary();

      // switch to the Sign tab so the person immediately sees the result
      document.querySelector('.view-tab[data-view="sign"]').click();
    } catch (err) {
      uploadStatus.textContent = err.message;
      uploadStatus.className = "status error";
    }
  }

  // ---------- Organize pages ----------
  const organizeState = { token: null, pages: [], order: [], rotations: {} };

  el("organize-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setToolStatus("organize-status", "Loading pages...", "");
    const formData = new FormData();
    formData.append("pdf", file);
    try {
      const res = await fetch("/api/tools/organize/pages", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not read PDF");

      organizeState.token = data.token;
      organizeState.pages = data.pages;
      organizeState.order = data.pages.map((p) => p.index);
      organizeState.rotations = {};
      renderOrganizeGrid();
      el("organize-btn").classList.remove("hidden");
      setToolStatus("organize-status", `Loaded ${data.pages.length} pages.`, "success");
    } catch (err) {
      setToolStatus("organize-status", err.message, "error");
    }
  });

  function renderOrganizeGrid() {
    const grid = el("organize-grid");
    grid.innerHTML = "";

    organizeState.order.forEach((originalIndex, position) => {
      const page = organizeState.pages.find((p) => p.index === originalIndex);
      const card = document.createElement("div");
      card.className = "organize-card";
      card.draggable = true;
      card.dataset.originalIndex = String(originalIndex);

      const img = document.createElement("img");
      img.src = `data:image/png;base64,${page.image_base64}`;
      const rotation = organizeState.rotations[originalIndex] || 0;
      img.style.transform = `rotate(${rotation}deg)`;
      card.appendChild(img);

      const label = document.createElement("div");
      label.className = "page-num";
      label.textContent = `Page ${position + 1}`;
      card.appendChild(label);

      const actions = document.createElement("div");
      actions.className = "card-actions";

      const rotateBtn = document.createElement("button");
      rotateBtn.textContent = "\u21BB";
      rotateBtn.title = "Rotate";
      rotateBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        organizeState.rotations[originalIndex] = ((organizeState.rotations[originalIndex] || 0) + 90) % 360;
        renderOrganizeGrid();
      });
      actions.appendChild(rotateBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "\u00D7";
      deleteBtn.title = "Remove this page";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        organizeState.order = organizeState.order.filter((idx) => idx !== originalIndex);
        renderOrganizeGrid();
      });
      actions.appendChild(deleteBtn);

      card.appendChild(actions);

      card.addEventListener("dragstart", () => card.classList.add("dragging"));
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        card.classList.add("drag-over");
      });
      card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        card.classList.remove("drag-over");
        const draggedEl = grid.querySelector(".dragging");
        if (!draggedEl || draggedEl === card) return;
        const draggedIdx = parseInt(draggedEl.dataset.originalIndex, 10);
        const targetIdx = parseInt(card.dataset.originalIndex, 10);
        const fromPos = organizeState.order.indexOf(draggedIdx);
        const toPos = organizeState.order.indexOf(targetIdx);
        organizeState.order.splice(fromPos, 1);
        organizeState.order.splice(toPos, 0, draggedIdx);
        renderOrganizeGrid();
      });

      grid.appendChild(card);
    });
  }

  el("organize-btn").addEventListener("click", async () => {
    if (!organizeState.token || organizeState.order.length === 0) {
      setToolStatus("organize-status", "No pages left to save.", "error");
      return;
    }
    setToolStatus("organize-status", "Applying changes...", "");
    try {
      const res = await fetch("/api/tools/organize/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: organizeState.token,
          order: organizeState.order,
          rotations: organizeState.rotations,
        }),
      });
      await downloadToolResult(res, "organized.pdf");
      setToolStatus("organize-status", "Done! Downloaded organized.pdf", "success");
    } catch (err) {
      setToolStatus("organize-status", err.message, "error");
    }
  });

})();
