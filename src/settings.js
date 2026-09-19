const invoke = window.__TAURI__.core.invoke;
const openDialog = window.__TAURI__.dialog.open;
const $ = (id) => document.getElementById(id);

const packCatalog = {
  Trendy: { symbol: "✦", label: "NOW", art: "linear-gradient(135deg,#eb9b5b,#b1445c)" },
  OG: { symbol: "◎", label: "CLASSICS", art: "linear-gradient(135deg,#547add,#26386e)" },
  "OG-Indian": { symbol: "◌", label: "INDIA", art: "linear-gradient(135deg,#e8af3f,#a54837)" },
  TV: { symbol: "▱", label: "SCREEN", art: "linear-gradient(135deg,#48aaa1,#1e526f)" },
  Moan: { symbol: "◒", label: "MATURE", art: "linear-gradient(135deg,#a65b84,#4b264e)", nsfw: true },
  "Chodu CID": { symbol: "◈", label: "MATURE", art: "linear-gradient(135deg,#a65f70,#59283c)", nsfw: true },
};

let settings;
let bundles = [];
let activeAlbum = null;
let activeSounds = [];
let accelerometerAvailable = false;
let saveTimer;
let toastTimer;

const categories = () => settings.selectedCategories || [];
const selectedSounds = () => settings.selectedSounds || [];
const activeBundle = () => bundles.find((bundle) => bundle.name === activeAlbum);
const packInfo = (name) => packCatalog[name] || {
  symbol: "◐",
  label: "LOCAL",
  art: "linear-gradient(135deg,#7688af,#3a4a67)",
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[character]));
}

function displayName(filename) {
  return filename
    .replace(/\.[^/.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function sortedAlbums() {
  const order = settings.albumOrder || [];
  return bundles.slice().sort((left, right) => {
    const leftIndex = order.indexOf(left.name);
    const rightIndex = order.indexOf(right.name);
    const leftRank = leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const rightRank = rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex;
    return leftRank - rightRank || left.name.localeCompare(right.name);
  });
}

function selectionState(bundle) {
  if (categories().includes(bundle.name)) return "all";
  return selectedSounds().some((sound) => sound.category === bundle.name) ? "partial" : "none";
}

function selectedCount(bundle) {
  if (selectionState(bundle) === "all") return bundle.count;
  return selectedSounds().filter((sound) => sound.category === bundle.name).length;
}

function settingsPayload() {
  return {
    ...settings,
    microphoneSensitivity: Number($("micSensitivity").value),
    accelerometerSensitivity: Number($("motionSensitivity").value),
    sensitivity: Number($("micSensitivity").value),
    cooldownMs: Number($("cooldown").value),
    useSystemVolume: $("systemVolume").checked,
    volume: Number($("appVolume").value),
    bundle: categories()[0] || selectedSounds()[0]?.category || "",
  };
}

function saveNow() {
  clearTimeout(saveTimer);
  const payload = settingsPayload();
  settings = payload;
  return invoke("save_settings", { newSettings: payload }).catch((error) => toast(String(error)));
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 180);
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2200);
}

function renderTheme() {
  document.body.dataset.theme = settings.theme || "system";
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeChoice === document.body.dataset.theme);
  });
}

function renderDetectionStatus() {
  const enabled = Boolean(settings.enabled);
  $("statusText").textContent = enabled ? "Detection on" : "Detection paused";
  $("detectionToggle").classList.toggle("on", enabled);
}

function renderLibrary() {
  const grid = $("albumGrid");
  const albums = sortedAlbums();
  const totalSounds = albums.reduce((total, album) => total + selectedCount(album), 0);
  $("libraryMeta").textContent = `${albums.length} packs · ${totalSounds} sounds in your mix`;
  $("nsfwSwitch").checked = Boolean(settings.nsfwEnabled);
  grid.innerHTML = "";

  albums.forEach((album) => {
    const info = packInfo(album.name);
    const state = selectionState(album);
    const locked = info.nsfw && !settings.nsfwEnabled;
    const badge = locked ? "⌁" : state === "all" ? "✓" : state === "partial" ? "–" : "";
    const detail = locked
      ? "Mature albums off"
      : state === "all"
        ? `${album.count} included`
        : state === "partial"
          ? `${selectedCount(album)} of ${album.count} included`
          : `${album.count} sounds`;

    const card = document.createElement("button");
    card.type = "button";
    card.className = `album-card ${state} ${activeAlbum === album.name ? "active" : ""} ${locked ? "locked" : ""}`;
    card.innerHTML = `
      <span class="pack-art" style="--art:${info.art}">
        <span class="art-symbol">${escapeHtml(info.symbol)}</span>
        <span class="art-label">${escapeHtml(info.label)}</span>
        ${badge ? `<span class="selection-badge">${badge}</span>` : ""}
      </span>
      <span class="album-name">${escapeHtml(album.name)}</span>
      <span class="album-detail">${escapeHtml(detail)}</span>`;
    card.addEventListener("click", () => openAlbum(album));
    grid.appendChild(card);
  });

  const newPack = document.createElement("button");
  newPack.type = "button";
  newPack.className = "new-pack";
  newPack.innerHTML = "<div><strong>＋</strong><span>New pack</span></div>";
  newPack.addEventListener("click", showNewPackModal);
  grid.appendChild(newPack);
}

async function openAlbum(album) {
  if (!album) return;
  if (packInfo(album.name).nsfw && !settings.nsfwEnabled) {
    toast("Turn on Mature albums to open this pack");
    return;
  }

  activeAlbum = album.name;
  activeSounds = (await invoke("list_bundle_sounds", { bundle: album.name }))
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
  renderLibrary();
  renderInspector();
}

function renderInspector() {
  const album = activeBundle();
  $("inspectorEmpty").hidden = Boolean(album);
  $("inspectorContent").hidden = !album;
  if (!album) return;

  const state = selectionState(album);
  const count = selectedCount(album);
  $("inspectorTitle").textContent = album.name;
  $("inspectorMeta").textContent = `${count} / ${album.count}`;
  $("includeAlbum").checked = state === "all";
  $("includeDetail").textContent = state === "all"
    ? `All ${album.count} sounds are included`
    : state === "partial"
      ? `${count} individual sounds are included`
      : album.count ? "Select every sound at once" : "This pack is ready for sounds";

  const allTracksSelected = activeSounds.length > 0 && activeSounds.every((sound) =>
    selectedSounds().some((item) => item.category === album.name && item.filename === sound.name));
  $("allSoundsButton").textContent = state === "all" || allTracksSelected ? "Clear all" : "Select all";
  $("allSoundsButton").disabled = activeSounds.length === 0;

  const list = $("soundList");
  list.innerHTML = "";
  if (!activeSounds.length) {
    list.innerHTML = '<p class="sound-list-empty">This pack is empty. Add sound files here, then choose what to include.</p>';
    return;
  }

  activeSounds.forEach((sound) => {
    const checked = state === "all" || selectedSounds().some((item) =>
      item.category === album.name && item.filename === sound.name);
    const row = document.createElement("label");
    row.className = "sound-row";
    row.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""} /><span class="sound-name">${escapeHtml(displayName(sound.name))}</span><span class="sound-type">Sound</span>`;
    row.querySelector("input").addEventListener("change", (event) => {
      toggleSound(album.name, sound.name, event.target.checked);
    });
    list.appendChild(row);
  });
}

function clearPack(name) {
  settings.selectedCategories = categories().filter((category) => category !== name);
  settings.selectedSounds = selectedSounds().filter((sound) => sound.category !== name);
}

function selectPack(album) {
  clearPack(album.name);
  settings.selectedCategories = [...categories(), album.name];
}

function normalizePackSelection(name) {
  const available = activeSounds.map((sound) => sound.name);
  const chosen = selectedSounds()
    .filter((sound) => sound.category === name)
    .map((sound) => sound.filename);
  if (available.length && available.every((filename) => chosen.includes(filename))) {
    const album = bundles.find((bundle) => bundle.name === name);
    if (album) selectPack(album);
  }
}

function updateSelection() {
  renderLibrary();
  renderInspector();
  saveSoon();
}

function toggleWholePack(checked) {
  const album = activeBundle();
  if (!album) return;
  if (checked) selectPack(album);
  else clearPack(album.name);
  updateSelection();
}

function toggleSound(category, filename, checked) {
  if (categories().includes(category)) {
    settings.selectedCategories = categories().filter((name) => name !== category);
    settings.selectedSounds = activeSounds
      .filter((sound) => sound.name !== filename)
      .map((sound) => ({ category, filename: sound.name }));
  } else {
    const withoutTrack = selectedSounds().filter((sound) =>
      !(sound.category === category && sound.filename === filename));
    settings.selectedSounds = checked
      ? [...withoutTrack, { category, filename }]
      : withoutTrack;
    normalizePackSelection(category);
  }
  updateSelection();
}

function toggleAllTracks() {
  const album = activeBundle();
  if (!album || !activeSounds.length) return;
  const allSelected = selectionState(album) === "all" || activeSounds.every((sound) =>
    selectedSounds().some((item) => item.category === album.name && item.filename === sound.name));
  if (allSelected) clearPack(album.name);
  else selectPack(album);
  updateSelection();
}

function renderTrigger() {
  $("micSensitivity").value = settings.microphoneSensitivity;
  $("motionSensitivity").value = settings.accelerometerSensitivity;
  $("cooldown").value = settings.cooldownMs;
  $("systemVolume").checked = settings.useSystemVolume;
  $("appVolume").value = settings.volume;
  $("modeChoice").querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === settings.detectionMode);
  });
  $("motionMode").disabled = !accelerometerAvailable;
  $("detectionDetail").textContent = accelerometerAvailable
    ? "Choose microphone or motion input"
    : "Motion is not available on this Mac";
  $("motionRow").classList.toggle("inactive", !accelerometerAvailable);
  $("motionSensitivity").disabled = !accelerometerAvailable;
  $("motionDetail").textContent = accelerometerAvailable
    ? "Used when Motion is selected"
    : "No compatible motion sensor detected";
  $("appVolumeRow").classList.toggle("inactive", settings.useSystemVolume);
  $("appVolume").disabled = settings.useSystemVolume;
  renderRangeValues();
  renderDetectionStatus();
}

function renderRangeValues() {
  $("micValue").value = Number($("micSensitivity").value).toFixed(2);
  $("motionValue").value = Number($("motionSensitivity").value).toFixed(2);
  $("cooldownValue").value = `${(Number($("cooldown").value) / 1000).toFixed(1)}s`;
  $("appVolumeValue").value = `${Math.round(Number($("appVolume").value) * 100)}%`;
}

async function setNsfwEnabled() {
  settings.nsfwEnabled = $("nsfwSwitch").checked;
  if (!settings.nsfwEnabled) {
    settings.selectedCategories = categories().filter((name) => !packInfo(name).nsfw);
    settings.selectedSounds = selectedSounds().filter((sound) => !packInfo(sound.category).nsfw);
    if (activeBundle() && packInfo(activeBundle().name).nsfw) {
      const nextPack = sortedAlbums().find((album) => !packInfo(album.name).nsfw);
      if (nextPack) await openAlbum(nextPack);
      else { activeAlbum = null; activeSounds = []; }
    }
  }
  renderLibrary();
  renderInspector();
  saveSoon();
  toast(settings.nsfwEnabled ? "Mature albums enabled" : "Mature albums excluded");
}

function setView(name) {
  document.querySelectorAll(".navigation-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === name);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === `${name}View`);
  });
  $("appShell").classList.toggle("inspector-hidden", name !== "library");
  if (name === "trigger") renderTrigger();
}

function showNewPackModal() {
  $("newAlbumModal").classList.add("show");
  $("newAlbumModal").setAttribute("aria-hidden", "false");
  $("newAlbumName").focus();
}

function hideNewPackModal() {
  $("newAlbumModal").classList.remove("show");
  $("newAlbumModal").setAttribute("aria-hidden", "true");
}

async function createPack() {
  const name = $("newAlbumName").value.trim();
  if (!name) return;
  try {
    await invoke("create_bundle", { name });
    bundles = await invoke("list_bundles");
    settings.albumOrder = [...(settings.albumOrder || []), name];
    $("newAlbumName").value = "";
    hideNewPackModal();
    await openAlbum(bundles.find((bundle) => bundle.name === name));
    saveSoon();
    toast("Sound pack created");
  } catch (error) {
    toast(String(error));
  }
}

async function addSounds() {
  const album = activeBundle();
  if (!album) return;
  const paths = await openDialog({
    multiple: true,
    filters: [{ name: "Audio", extensions: ["wav", "mp3", "ogg", "flac"] }],
  });
  if (!paths) return;
  await invoke("import_sounds", { bundle: album.name, paths: Array.isArray(paths) ? paths : [paths] });
  bundles = await invoke("list_bundles");
  await openAlbum(bundles.find((bundle) => bundle.name === album.name));
  saveSoon();
  toast("Sounds added");
}

async function testMix() {
  try {
    await invoke("test_selection", { selection: settingsPayload() });
    toast("Playing test sound");
  } catch (error) {
    toast(String(error));
  }
}

async function load() {
  settings = await invoke("get_settings");
  bundles = await invoke("list_bundles");
  const capabilities = await invoke("get_detector_capabilities");
  accelerometerAvailable = capabilities.accelerometerAvailable;
  settings.selectedCategories ||= [];
  settings.selectedSounds ||= [];
  settings.albumOrder ||= [];
  settings.microphoneSensitivity ||= settings.sensitivity || .15;
  settings.accelerometerSensitivity ||= settings.sensitivity || .15;
  settings.useSystemVolume = settings.useSystemVolume !== false;
  settings.theme ||= "system";
  if (!accelerometerAvailable && settings.detectionMode === "accelerometer") {
    settings.detectionMode = "microphone";
    saveSoon();
  }

  const initialAlbum = categories()[0]
    || selectedSounds()[0]?.category
    || sortedAlbums().find((album) => !packInfo(album.name).nsfw || settings.nsfwEnabled)?.name;
  if (initialAlbum) await openAlbum(bundles.find((bundle) => bundle.name === initialAlbum));
  renderTheme();
  renderLibrary();
  renderInspector();
  renderTrigger();
}

document.querySelectorAll("[data-theme-choice]").forEach((button) => {
  button.addEventListener("click", () => { settings.theme = button.dataset.themeChoice; renderTheme(); saveSoon(); });
});
document.querySelectorAll(".navigation-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
$("detectionToggle").addEventListener("click", () => { settings.enabled = !settings.enabled; renderDetectionStatus(); saveSoon(); });
$("nsfwSwitch").addEventListener("change", setNsfwEnabled);
$("includeAlbum").addEventListener("change", (event) => toggleWholePack(event.target.checked));
$("allSoundsButton").addEventListener("click", toggleAllTracks);
$("addSoundButton").addEventListener("click", addSounds);
$("testMix").addEventListener("click", testMix);
$("createAlbum").addEventListener("click", createPack);
$("cancelAlbum").addEventListener("click", hideNewPackModal);
$("modeChoice").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  settings.detectionMode = button.dataset.mode;
  renderTrigger();
  saveSoon();
});
["micSensitivity", "motionSensitivity", "cooldown", "appVolume"].forEach((id) => {
  $(id).addEventListener("input", () => { renderRangeValues(); saveSoon(); });
});
$("systemVolume").addEventListener("change", () => { settings.useSystemVolume = $("systemVolume").checked; renderTrigger(); saveSoon(); });
window.addEventListener("keydown", (event) => { if (event.key === "Escape") hideNewPackModal(); });

load().catch((error) => toast(`Could not load library: ${error}`));
