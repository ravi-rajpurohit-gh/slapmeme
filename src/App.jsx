import { useEffect, useMemo, useRef, useState } from "react";

const previewBundles = [
  { name: "Trendy", count: 6 }, { name: "OG", count: 4 }, { name: "OG-Indian", count: 3 },
  { name: "TV", count: 5 }, { name: "Moan", count: 2 }, { name: "Chodu CID", count: 1 },
];
const previewSounds = Object.fromEntries(previewBundles.map((bundle) => [
  bundle.name,
  Array.from({ length: bundle.count }, (_, index) => ({ name: `${bundle.name}_${index + 1}.mp3` })),
]));
let previewSettings = {
  sensitivity: .15, microphoneSensitivity: .15, accelerometerSensitivity: .15, cooldownMs: 2000,
  volume: .8, useSystemVolume: true, enabled: false, detectionMode: "microphone", bundle: "",
  selectedCategories: [], selectedSounds: [], albumOrder: previewBundles.map((bundle) => bundle.name),
  nsfwEnabled: false, theme: "system", portRules: [], hideSupportPrompt: false,
};
const tauriInvoke = window.__TAURI__?.core?.invoke;
const invoke = tauriInvoke
  ? (command, args) => tauriInvoke(command, args)
  : async (command, args = {}) => {
    if (command === "get_settings") return previewSettings;
    if (command === "save_settings") { previewSettings = args.newSettings; return; }
    if (command === "list_bundles") return previewBundles;
    if (command === "list_bundle_sounds") return previewSounds[args.bundle] || [];
    if (command === "get_detector_capabilities") return { accelerometerAvailable: false };
    if (command === "test_selection") return;
    if (command === "create_bundle") {
      previewBundles.push({ name: args.name, count: 0 }); previewSounds[args.name] = []; return;
    }
    throw new Error(`The '${command}' command is available in the desktop app.`);
  };
const openDialog = window.__TAURI__?.dialog?.open
  ? (options) => window.__TAURI__.dialog.open(options)
  : async () => null;

const PACKS = {
  Trendy: { symbol: "✦", label: "NOW", art: "trendy" },
  OG: { symbol: "◎", label: "CLASSICS", art: "og" },
  "OG-Indian": { symbol: "◌", label: "INDIA", art: "indian" },
  TV: { symbol: "▱", label: "SCREEN", art: "tv" },
  Moan: { symbol: "◒", label: "MATURE", art: "moan", nsfw: true },
  "Chodu CID": { symbol: "◈", label: "MATURE", art: "cid", nsfw: true },
};

const packInfo = (name) => PACKS[name] || { symbol: "◐", label: "LOCAL", art: "local" };
const displayName = (filename) => filename
  .replace(/\.[^/.]+$/, "")
  .replace(/[-_]+/g, " ")
  .replace(/\b\w/g, (character) => character.toUpperCase());

function orderedAlbums(bundles, albumOrder) {
  return [...bundles].sort((left, right) => {
    const leftIndex = albumOrder.indexOf(left.name);
    const rightIndex = albumOrder.indexOf(right.name);
    const leftRank = leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const rightRank = rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex;
    return leftRank - rightRank || left.name.localeCompare(right.name);
  });
}

function selectionState(settings, album) {
  if (settings.selectedCategories.includes(album.name)) return "all";
  return settings.selectedSounds.some((sound) => sound.category === album.name) ? "partial" : "none";
}

function selectedCount(settings, album) {
  return selectionState(settings, album) === "all"
    ? album.count
    : settings.selectedSounds.filter((sound) => sound.category === album.name).length;
}

function normalizeSettings(raw) {
  return {
    ...raw,
    selectedCategories: raw.selectedCategories || [],
    selectedSounds: raw.selectedSounds || [],
    albumOrder: raw.albumOrder || [],
    microphoneSensitivity: raw.microphoneSensitivity || raw.sensitivity || 0.15,
    accelerometerSensitivity: raw.accelerometerSensitivity || raw.sensitivity || 0.15,
    useSystemVolume: raw.useSystemVolume !== false,
    theme: raw.theme || "system",
  };
}

function persistPayload(settings) {
  return {
    ...settings,
    bundle: settings.selectedCategories[0] || settings.selectedSounds[0]?.category || "",
  };
}

function App() {
  const [settings, setSettings] = useState(null);
  const [bundles, setBundles] = useState([]);
  const [activeAlbum, setActiveAlbum] = useState(null);
  const [activeSounds, setActiveSounds] = useState([]);
  const [view, setView] = useState("library");
  const [accelerometerAvailable, setAccelerometerAvailable] = useState(false);
  const [newPackOpen, setNewPackOpen] = useState(false);
  const [newPackName, setNewPackName] = useState("");
  const [toast, setToast] = useState("");
  const [loadError, setLoadError] = useState("");
  const saveTimer = useRef();
  const toastTimer = useRef();

  const albums = useMemo(
    () => orderedAlbums(bundles, settings?.albumOrder || []),
    [bundles, settings?.albumOrder],
  );
  const activeBundle = bundles.find((bundle) => bundle.name === activeAlbum) || null;

  useEffect(() => () => {
    clearTimeout(saveTimer.current);
    clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [rawSettings, listedBundles, capabilities] = await Promise.all([
          invoke("get_settings"),
          invoke("list_bundles"),
          invoke("get_detector_capabilities"),
        ]);
        if (cancelled) return;
        const nextSettings = normalizeSettings(rawSettings);
        if (!capabilities.accelerometerAvailable && nextSettings.detectionMode === "accelerometer") {
          nextSettings.detectionMode = "microphone";
          invoke("save_settings", { newSettings: persistPayload(nextSettings) }).catch(() => {});
        }
        setSettings(nextSettings);
        setBundles(listedBundles);
        setAccelerometerAvailable(capabilities.accelerometerAvailable);

        const initialName = nextSettings.selectedCategories[0]
          || nextSettings.selectedSounds[0]?.category
          || orderedAlbums(listedBundles, nextSettings.albumOrder)
            .find((album) => !packInfo(album.name).nsfw || nextSettings.nsfwEnabled)?.name;
        if (initialName) await loadAlbum(initialName, listedBundles, cancelled);
      } catch (error) {
        if (!cancelled) setLoadError(String(error));
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  async function loadAlbum(name, sourceBundles = bundles, cancelled = false) {
    if (!sourceBundles.some((bundle) => bundle.name === name) || cancelled) return;
    const sounds = await invoke("list_bundle_sounds", { bundle: name });
    if (cancelled) return;
    setActiveAlbum(name);
    setActiveSounds([...sounds].sort((left, right) => left.name.localeCompare(right.name)));
  }

  function showToast(message) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2200);
  }

  function save(nextSettings, immediate = false) {
    clearTimeout(saveTimer.current);
    const commit = () => invoke("save_settings", { newSettings: persistPayload(nextSettings) })
      .catch((error) => showToast(String(error)));
    if (immediate) return commit();
    saveTimer.current = setTimeout(commit, 180);
    return undefined;
  }

  function updateSettings(updater, immediate = false) {
    setSettings((current) => {
      const next = updater(current);
      save(next, immediate);
      return next;
    });
  }

  async function openAlbum(album) {
    if (!settings) return;
    if (packInfo(album.name).nsfw && !settings.nsfwEnabled) {
      showToast("Turn on Mature albums to open this pack");
      return;
    }
    await loadAlbum(album.name);
  }

  function selectPack(current, album) {
    const withoutPack = current.selectedCategories.filter((name) => name !== album.name);
    return {
      ...current,
      selectedCategories: [...withoutPack, album.name],
      selectedSounds: current.selectedSounds.filter((sound) => sound.category !== album.name),
    };
  }

  function clearPack(current, name) {
    return {
      ...current,
      selectedCategories: current.selectedCategories.filter((category) => category !== name),
      selectedSounds: current.selectedSounds.filter((sound) => sound.category !== name),
    };
  }

  function toggleWholePack(checked) {
    if (!activeBundle) return;
    updateSettings((current) => checked ? selectPack(current, activeBundle) : clearPack(current, activeBundle.name));
  }

  function toggleSound(filename, checked) {
    if (!activeBundle) return;
    updateSettings((current) => {
      const category = activeBundle.name;
      const selectedNames = new Set(
        current.selectedCategories.includes(category)
          ? activeSounds.map((sound) => sound.name)
          : current.selectedSounds
            .filter((sound) => sound.category === category)
            .map((sound) => sound.filename),
      );
      if (checked) selectedNames.add(filename);
      else selectedNames.delete(filename);

      const withoutPack = clearPack(current, category);
      const allTracksChosen = activeSounds.length > 0
        && activeSounds.every((sound) => selectedNames.has(sound.name));
      if (allTracksChosen) return selectPack(withoutPack, activeBundle);
      return {
        ...withoutPack,
        selectedSounds: [
          ...withoutPack.selectedSounds,
          ...activeSounds
            .filter((sound) => selectedNames.has(sound.name))
            .map((sound) => ({ category, filename: sound.name })),
        ],
      };
    });
  }

  function toggleAllTracks() {
    if (!activeBundle || !activeSounds.length) return;
    updateSettings((current) => {
      const allSelected = selectionState(current, activeBundle) === "all" || activeSounds.every((sound) =>
        current.selectedSounds.some((item) => item.category === activeBundle.name && item.filename === sound.name));
      return allSelected ? clearPack(current, activeBundle.name) : selectPack(current, activeBundle);
    });
  }

  async function toggleMatureAlbums(checked) {
    const next = checked
      ? { ...settings, nsfwEnabled: true }
      : {
        ...settings,
        nsfwEnabled: false,
        selectedCategories: settings.selectedCategories.filter((name) => !packInfo(name).nsfw),
        selectedSounds: settings.selectedSounds.filter((sound) => !packInfo(sound.category).nsfw),
      };
    setSettings(next);
    save(next);
    if (!checked && activeBundle && packInfo(activeBundle.name).nsfw) {
      const nextAlbum = albums.find((album) => !packInfo(album.name).nsfw);
      if (nextAlbum) await loadAlbum(nextAlbum.name);
      else { setActiveAlbum(null); setActiveSounds([]); }
    }
    showToast(checked ? "Mature albums enabled" : "Mature albums excluded");
  }

  async function createPack() {
    const name = newPackName.trim();
    if (!name) return;
    try {
      await invoke("create_bundle", { name });
      const nextBundles = await invoke("list_bundles");
      const nextSettings = { ...settings, albumOrder: [...settings.albumOrder, name] };
      setBundles(nextBundles);
      setSettings(nextSettings);
      save(nextSettings);
      setNewPackName("");
      setNewPackOpen(false);
      await loadAlbum(name, nextBundles);
      showToast("Sound pack created");
    } catch (error) {
      showToast(String(error));
    }
  }

  async function addSounds() {
    if (!activeBundle) return;
    const paths = await openDialog({
      multiple: true,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "ogg", "flac"] }],
    });
    if (!paths) return;
    try {
      await invoke("import_sounds", {
        bundle: activeBundle.name,
        paths: Array.isArray(paths) ? paths : [paths],
      });
      const nextBundles = await invoke("list_bundles");
      setBundles(nextBundles);
      await loadAlbum(activeBundle.name, nextBundles);
      showToast("Sounds added");
    } catch (error) {
      showToast(String(error));
    }
  }

  async function testMix() {
    try {
      await invoke("test_selection", { selection: persistPayload(settings) });
      showToast("Playing test sound");
    } catch (error) {
      showToast(String(error));
    }
  }

  if (loadError) return <div className="startup-message">Could not load Meme Machine: {loadError}</div>;
  if (!settings) return <div className="startup-message">Loading Meme Machine…</div>;

  const selectedTotal = albums.reduce((total, album) => total + selectedCount(settings, album), 0);
  const activeState = activeBundle ? selectionState(settings, activeBundle) : "none";
  const activeSelected = activeBundle ? selectedCount(settings, activeBundle) : 0;
  const allIndividualTracksSelected = activeBundle && activeSounds.length > 0 && activeSounds.every((sound) =>
    settings.selectedSounds.some((item) => item.category === activeBundle.name && item.filename === sound.name));

  return <div className="application" data-theme={settings.theme}>
    <header className="window-toolbar">
      <div className="app-title"><span className="app-mark" aria-hidden="true"><i /><i /><i /></span><span>Meme Machine</span></div>
      <div className="toolbar-controls">
        <div className="appearance-control" aria-label="Appearance">
          {["system", "light", "dark"].map((theme) => <button key={theme} type="button" className={settings.theme === theme ? "active" : ""} onClick={() => updateSettings((current) => ({ ...current, theme }))}>{theme[0].toUpperCase() + theme.slice(1)}</button>)}
        </div>
      </div>
    </header>

    <div className={`app-shell ${view !== "library" ? "inspector-hidden" : ""}`}>
      <aside className="navigation">
        <p className="navigation-label">Meme Machine</p>
        <nav aria-label="Main navigation">
          <NavigationButton active={view === "library"} icon="▦" label="Library" onClick={() => setView("library")} />
          <NavigationButton active={view === "trigger"} icon="⚙" label="Settings" onClick={() => setView("trigger")} />
        </nav>
        <div className="navigation-spacer" />
      </aside>

      <main className="main-content">
        {view === "library" ? <LibraryView albums={albums} settings={settings} activeAlbum={activeAlbum} selectedTotal={selectedTotal} onOpen={openAlbum} onNewPack={() => setNewPackOpen(true)} onTest={testMix} /> : <SettingsView settings={settings} accelerometerAvailable={accelerometerAvailable} updateSettings={updateSettings} onToggleMature={toggleMatureAlbums} />}
      </main>

      {view === "library" && <Inspector activeBundle={activeBundle} activeSounds={activeSounds} selectionState={activeState} selectedCount={activeSelected} allTracksSelected={allIndividualTracksSelected} settings={settings} onToggleWhole={toggleWholePack} onToggleTrack={toggleSound} onToggleAll={toggleAllTracks} onAddSounds={addSounds} />}
    </div>

    {newPackOpen && <NewPackModal name={newPackName} onNameChange={setNewPackName} onCancel={() => setNewPackOpen(false)} onCreate={createPack} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

function NavigationButton({ active, icon, label, onClick }) {
  return <button className={`navigation-item ${active ? "active" : ""}`} type="button" onClick={onClick}><span className="navigation-icon" aria-hidden="true">{icon}</span>{label}</button>;
}

function Switch({ checked, label, onChange }) {
  return <label className="switch"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} aria-label={label} /><span /></label>;
}

function LibraryView({ albums, settings, activeAlbum, selectedTotal, onOpen, onNewPack, onTest }) {
  return <section className="view active">
    <div className="content-heading"><div><p className="eyebrow">YOUR COLLECTION</p><h1>Sound packs</h1><p className="heading-detail">{albums.length} packs · {selectedTotal} sounds in your mix</p></div><button className="secondary-button" type="button" onClick={onTest}>Test mix</button></div>
    <div className="album-grid">
      {albums.map((album) => <AlbumCard key={album.name} album={album} settings={settings} active={activeAlbum === album.name} onOpen={onOpen} />)}
      <button className="new-pack" type="button" onClick={onNewPack}><div><strong>＋</strong><span>New pack</span></div></button>
    </div>
  </section>;
}

function AlbumCard({ album, settings, active, onOpen }) {
  const info = packInfo(album.name);
  const state = selectionState(settings, album);
  const locked = info.nsfw && !settings.nsfwEnabled;
  const badge = state === "all" ? "✓" : "";
  const detail = locked ? "Mature albums off" : state === "all" ? `${album.count} included` : state === "partial" ? `${selectedCount(settings, album)} of ${album.count} included` : `${album.count} sounds`;
  return <button className={`album-card ${state} ${active ? "active" : ""} ${locked ? "locked" : ""}`} type="button" onClick={() => onOpen(album)}>
    <span className={`pack-art ${info.art}`}><span className="art-symbol">{info.symbol}</span><span className="art-label">{info.label}</span>{badge && <span className="selection-badge">{badge}</span>}</span>
    <span className="album-name">{album.name}</span><span className="album-detail">{detail}</span>
  </button>;
}

function Inspector({ activeBundle, activeSounds, selectionState: state, selectedCount: count, allTracksSelected, settings, onToggleWhole, onToggleTrack, onToggleAll, onAddSounds }) {
  if (!activeBundle) return <aside className="inspector"><div className="inspector-empty"><div><div className="empty-art" aria-hidden="true">♫</div><h2>Select a sound pack</h2><p>Choose a pack to decide exactly what belongs in your mix.</p></div></div></aside>;
  const showClear = state === "all" || allTracksSelected;
  return <aside className="inspector" aria-label="Sound pack details"><div className="inspector-content">
    <header className="inspector-header"><p className="eyebrow">EDITING PACK</p><div className="inspector-title-row"><h2>{activeBundle.name}</h2><span className="selection-total">{count} / {activeBundle.count}</span></div>
      <div className="include-pack"><div><strong>Include whole pack</strong><span>{state === "all" ? `All ${activeBundle.count} sounds are included` : state === "partial" ? `${count} individual sounds are included` : activeBundle.count ? "Select every sound at once" : "This pack is ready for sounds"}</span></div><Switch checked={state === "all"} label="Include whole pack" onChange={onToggleWhole} /></div>
      <div className="track-tools"><span>Sounds</span><button type="button" disabled={!activeSounds.length} onClick={onToggleAll}>{showClear ? "Clear all" : "Select all"}</button></div>
    </header>
    <div className="sound-list">{activeSounds.length ? activeSounds.map((sound) => { const checked = state === "all" || settings.selectedSounds.some((item) => item.category === activeBundle.name && item.filename === sound.name); return <label className="sound-row" key={sound.name}><input type="checkbox" checked={checked} onChange={(event) => onToggleTrack(sound.name, event.target.checked)} /><span className="sound-name">{displayName(sound.name)}</span><span className="sound-type">Sound</span></label>; }) : <p className="sound-list-empty">This pack is empty. Add sound files here, then choose what to include.</p>}</div>
    <button className="add-sounds-button" type="button" onClick={onAddSounds}>＋ Add sounds</button>
  </div></aside>;
}

function SettingsView({ settings, accelerometerAvailable, updateSettings, onToggleMature }) {
  const update = (changes) => updateSettings((current) => ({ ...current, ...changes }));
  return <section className="view active"><div className="content-heading"><div><p className="eyebrow">SETTINGS</p><h1>Settings</h1><p className="heading-detail">Control detection, your mix, and playback behavior.</p></div></div>
    <section className="preferences-group"><h2>General</h2>
      <div className="preference-row"><div><strong>Detection</strong><span>{settings.enabled ? "Listening for your trigger" : "Paused"}</span></div><Switch checked={settings.enabled} label="Enable detection" onChange={(enabled) => update({ enabled })} /></div>
      <div className="preference-row"><div><strong>Mature albums</strong><span>Include mature packs in your mix</span></div><Switch checked={settings.nsfwEnabled} label="Include mature albums" onChange={onToggleMature} /></div>
    </section>
    <section className="preferences-group"><h2>Input</h2>
      <div className="preference-row"><div><strong>Detection source</strong><span>{accelerometerAvailable ? "Choose microphone or motion input" : "Motion is not available on this Mac"}</span></div><div className="segmented-control"><button type="button" className={settings.detectionMode === "microphone" ? "active" : ""} onClick={() => update({ detectionMode: "microphone" })}>Microphone</button><button type="button" disabled={!accelerometerAvailable} className={settings.detectionMode === "accelerometer" ? "active" : ""} onClick={() => update({ detectionMode: "accelerometer" })}>Motion</button></div></div>
      <RangeRow label="Microphone sensitivity" detail="Higher responds to quieter taps" value={settings.microphoneSensitivity} min="0.01" max="0.5" step="0.01" format={(value) => Number(value).toFixed(2)} onChange={(microphoneSensitivity) => update({ microphoneSensitivity, sensitivity: microphoneSensitivity })} />
      <RangeRow inactive={!accelerometerAvailable} disabled={!accelerometerAvailable} label="Motion sensitivity" detail={accelerometerAvailable ? "Used when Motion is selected" : "No compatible motion sensor detected"} value={settings.accelerometerSensitivity} min="0.01" max="0.5" step="0.01" format={(value) => Number(value).toFixed(2)} onChange={(accelerometerSensitivity) => update({ accelerometerSensitivity })} />
      <RangeRow label="Cooldown" detail="Prevents repeat triggers" value={settings.cooldownMs} min="200" max="10000" step="100" format={(value) => `${(Number(value) / 1000).toFixed(1)}s`} onChange={(cooldownMs) => update({ cooldownMs: Number(cooldownMs) })} />
    </section>
    <section className="preferences-group"><h2>Output</h2><div className="preference-row"><div><strong>Use system volume</strong><span>Follow your Mac’s output level</span></div><Switch checked={settings.useSystemVolume} label="Use system volume" onChange={(useSystemVolume) => update({ useSystemVolume })} /></div><RangeRow inactive={settings.useSystemVolume} disabled={settings.useSystemVolume} label="App volume" detail="Independent playback level" value={settings.volume} min="0" max="1" step="0.05" format={(value) => `${Math.round(Number(value) * 100)}%`} onChange={(volume) => update({ volume: Number(volume) })} /></section>
  </section>;
}

function RangeRow({ label, detail, value, min, max, step, format, onChange, inactive, disabled }) {
  return <div className={`preference-row ${inactive ? "inactive" : ""}`}><div><strong>{label}</strong><span>{detail}</span></div><div className="range-control"><input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} /><output>{format(value)}</output></div></div>;
}

function NewPackModal({ name, onNameChange, onCancel, onCreate }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="newPackTitle"><h2 id="newPackTitle">New sound pack</h2><p>Make a local pack, then add your sound files.</p><input autoFocus value={name} placeholder="Pack name" maxLength="50" onChange={(event) => onNameChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onCreate(); if (event.key === "Escape") onCancel(); }} /><div className="modal-actions"><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button><button className="primary-button" type="button" onClick={onCreate}>Create</button></div></section></div>;
}

export default App;
