const $ = (id) => document.getElementById(id);

const state = { tabId: null, onHmis: false, busy: false, connectivity: "not checked", lastAction: null };

function setStatus(message, kind = "") {
  const el = $("status");
  el.textContent = message;
  el.className = "status " + kind;
}

function updateButtons() {
  document.querySelectorAll("[data-hmis]").forEach((btn) => {
    btn.disabled = state.busy || !state.onHmis;
  });
  $("checkBtn").disabled = state.busy;
  $("offSite").hidden = state.onHmis;
}

function setBusy(busy) {
  state.busy = busy;
  updateButtons();
}

function setConnection(kind, text) {
  $("connDot").className = "dot " + kind;
  $("connText").textContent = text;
  state.connectivity = text;
}

async function detectTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab ? tab.id : null;
  state.onHmis = Boolean(tab && tab.url && tab.url.startsWith(CONFIG.origin + "/"));
}

function formatTime(ms) {
  return new Date(ms).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
}

function renderLastAction() {
  const el = $("lastAction");
  if (!state.lastAction) {
    el.textContent = "No actions yet";
    return;
  }
  const when = formatTime(state.lastAction.time);
  el.textContent = `Last: ${state.lastAction.name}, ${when}`;
}

async function recordAction(name) {
  state.lastAction = { name, time: Date.now() };
  renderLastAction();
  try {
    await chrome.storage.local.set({ lastAction: state.lastAction });
  } catch (e) {
    return;
  }
}

async function runAction(name, task, successMessage) {
  setBusy(true);
  $("feedback").hidden = true;
  setStatus("Working...");
  try {
    await task();
    await recordAction(name);
    setStatus(successMessage, "ok");
    $("feedback").hidden = false;
  } catch (e) {
    setStatus("Failed: " + (e && e.message ? e.message : "unknown error"), "err");
  } finally {
    setBusy(false);
  }
}

async function fixHmis() {
  if (!confirm("Save any unfinished work first.\n\nThis clears Health Cloud cached files and reloads this tab. Continue?")) return;
  await runAction("Fix Health Cloud", async () => {
    await chrome.browsingData.remove(
      { origins: [CONFIG.origin] },
      { cache: true, cacheStorage: true, serviceWorkers: true }
    );
    await chrome.tabs.reload(state.tabId, { bypassCache: true });
  }, "Cache cleared and page reloaded.");
}

async function hardRefresh() {
  await runAction("Hard refresh", async () => {
    await chrome.tabs.reload(state.tabId, { bypassCache: true });
  }, "Page reloaded without cache.");
}

async function resetSession() {
  if (!confirm("You will be logged out of Health Cloud and unsaved work will be lost.\n\nContinue?")) return;
  await runAction("Reset session data", async () => {
    await chrome.browsingData.remove(
      { origins: [CONFIG.origin] },
      { cache: true, cacheStorage: true, serviceWorkers: true, cookies: true, localStorage: true, indexedDB: true }
    );
    await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: () => sessionStorage.clear()
    });
    await chrome.tabs.reload(state.tabId, { bypassCache: true });
  }, "Session data cleared. Log in again.");
}

async function checkConnection() {
  setBusy(true);
  setConnection("", "Checking...");
  if (!navigator.onLine) {
    setConnection("err", "No internet");
    setStatus("This computer has no network connection.", "err");
    setBusy(false);
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.connectivityTimeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(CONFIG.origin + "/", {
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal
    });
    const ms = Math.round(performance.now() - started);
    if (response.ok) {
      setConnection("ok", `Reachable (${ms} ms)`);
      setStatus("Health Cloud server is reachable. This does not prove every feature works.", "ok");
    } else {
      setConnection("warn", `Server error ${response.status}`);
      setStatus(`Health Cloud server answered with error ${response.status}. Contact IT.`, "err");
    }
  } catch (e) {
    if (e.name === "AbortError") {
      setConnection("warn", "Timed out");
      setStatus("Health Cloud server did not answer in time. Network may be slow or Health Cloud is down.", "err");
    } else {
      setConnection("err", "Unreachable");
      setStatus("Could not reach Health Cloud. Check the network or contact IT.", "err");
    }
  } finally {
    clearTimeout(timer);
    setBusy(false);
  }
}

function renderContact() {
  const { name, phone, contacts } = CONFIG.support;
  const box = $("contactInfo");
  box.textContent = "";
  const add = (text) => {
    const p = document.createElement("p");
    p.textContent = text;
    box.appendChild(p);
  };
  const title = document.createElement("p");
  title.className = "contact-title";
  title.textContent = name;
  box.appendChild(title);
  contacts.forEach((c) => {
    const card = document.createElement("div");
    card.className = "contact";
    const role = document.createElement("span");
    role.className = "role";
    role.textContent = c.role;
    const mail = document.createElement("span");
    mail.className = "email";
    mail.textContent = c.email;
    card.append(role, mail);
    box.appendChild(card);
  });
  if (phone) add("Phone: " + phone);
  if (!phone && contacts.length === 0) add("Contact details are not configured yet.");
}

function diagnostics() {
  const chromeVersion = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || "unknown";
  return [
    `Extension version: ${chrome.runtime.getManifest().version}`,
    `Chrome version: ${chromeVersion}`,
    `Operating system: ${(navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform}`,
    `Network online: ${navigator.onLine}`,
    `Health Cloud check: ${state.connectivity}`,
    `Computer date and time: ${formatTime(Date.now())}`
  ].join("\n");
}

function describeTried() {
  const last = state.lastAction;
  if (!last) return "Nothing yet.";
  let result = "not answered";
  if (last.resolved === true) result = "Fixed";
  if (last.resolved === false) result = "Not fixed";
  return `${last.name} at ${formatTime(last.time)}. Result: ${result}.`;
}

async function recordResult(resolved) {
  if (!state.lastAction) return;
  state.lastAction.resolved = resolved;
  try {
    await chrome.storage.local.set({ lastAction: state.lastAction });
  } catch (e) {
    return;
  }
}

function buildReportLink() {
  const email = CONFIG.support.contacts.map((c) => c.email).join(",");
  if (!email) {
    $("outlookLink").hidden = true;
    $("mailLink").hidden = true;
    return;
  }
  const category = $("issueType").value || "Not specified";
  const urgency = $("urgency").value;
  const urgentTag = urgency === "Urgent" ? " (Urgent)" : "";
  const subject = encodeURIComponent(`Health Cloud issue: ${category}${urgentTag}`);
  const lines = [];
  if (urgency === "Urgent") lines.push("URGENT: patient care is affected", "");
  lines.push(
    `Issue type: ${category}`,
    `Urgency: ${urgency}`,
    "",
    "My name:",
    "Department:",
    "Phone or Ext:",
    "",
    "Page or menu (for example Patients):",
    "What is wrong (write the error message if you see one):",
    "",
    `What I tried: ${describeTried()}`,
    "",
    "Please do not write patient names or ID numbers.",
    "",
    "--- Technical details ---",
    diagnostics()
  );
  const body = encodeURIComponent(lines.join("\n"));
  const query = `subject=${subject}&body=${body}`;
  $("outlookLink").href = `https://outlook.office.com/mail/deeplink/compose?to=${email}&${query}`;
  $("mailLink").href = `mailto:${email}?${query}`;
}

function bindFeedback() {
  $("yesBtn").addEventListener("click", () => {
    $("feedback").hidden = true;
    recordResult(true);
    setStatus("Glad it worked.", "ok");
  });
  $("noBtn").addEventListener("click", () => {
    $("feedback").hidden = true;
    recordResult(false);
    setStatus("Try Hard refresh or Reset session data, then contact IT if it continues.", "err");
    $("contactBox").open = true;
    buildReportLink();
  });
}

async function init() {
  $("version").textContent = "v" + chrome.runtime.getManifest().version;
  renderContact();
  bindFeedback();

  CONFIG.issueCategories.forEach((label) => {
    const option = document.createElement("option");
    option.value = label;
    option.textContent = label;
    $("issueType").appendChild(option);
  });
  $("issueType").addEventListener("change", buildReportLink);
  $("urgency").addEventListener("change", buildReportLink);

  $("fixBtn").addEventListener("click", fixHmis);
  $("refreshBtn").addEventListener("click", hardRefresh);
  $("resetBtn").addEventListener("click", resetSession);
  $("checkBtn").addEventListener("click", async () => {
    await checkConnection();
    buildReportLink();
  });
  $("contactBox").addEventListener("toggle", buildReportLink);

  try {
    const stored = await chrome.storage.local.get("lastAction");
    state.lastAction = stored.lastAction || null;
  } catch (e) {
    state.lastAction = null;
  }
  renderLastAction();

  await detectTab();
  updateButtons();
  await checkConnection();
  buildReportLink();
}

init();
