importScripts("config.js");

const ALARM_NAME = "serverStatusCheck";
const COLORS = { ok: "#2e8b57", slow: "#d68a00", down: "#c0392b" };
const LABELS = { ok: "OK", slow: "SLOW", down: "DOWN" };

async function probe() {
  if (!navigator.onLine) return { state: "down", detail: "No network" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.connectivityTimeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(CONFIG.origin + "/", {
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal
    });
    const ms = Date.now() - started;
    if (!response.ok) return { state: "down", detail: `Server error ${response.status}` };
    if (ms > CONFIG.slowThresholdMs) return { state: "slow", detail: `Slow (${ms} ms)` };
    return { state: "ok", detail: `Reachable (${ms} ms)` };
  } catch (e) {
    return { state: "down", detail: e.name === "AbortError" ? "Timed out" : "Unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

async function updateBadge() {
  const { state, detail } = await probe();
  await chrome.action.setBadgeText({ text: LABELS[state] });
  await chrome.action.setBadgeBackgroundColor({ color: COLORS[state] });
  await chrome.action.setTitle({ title: `${chrome.runtime.getManifest().name}: ${detail}` });
}

function schedule() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: CONFIG.statusCheckMinutes });
  updateBadge();
}

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) updateBadge();
});
