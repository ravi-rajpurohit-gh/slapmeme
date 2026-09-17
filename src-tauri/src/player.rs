use rand::seq::SliceRandom;
use rodio::{Decoder, OutputStream, Sink};
use crate::settings::{PlaybackOrder, SelectedSound};
use std::collections::HashSet;
use std::fs;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::mpsc;

struct PlayCmd {
    files: Vec<PathBuf>,
    volume: f32,
    intensity: f32,
    playback_order: PlaybackOrder,
}

/// Thread-safe handle to play sounds (Send + Sync).
pub struct PlayerHandle {
    cmd_tx: mpsc::Sender<PlayCmd>,
    sounds_dir: PathBuf,
}

impl PlayerHandle {
    pub fn new(sounds_dir: PathBuf) -> Self {
        fs::create_dir_all(&sounds_dir).ok();

        let (cmd_tx, cmd_rx) = mpsc::channel::<PlayCmd>();
        std::thread::spawn(move || {
            let (_stream, stream_handle) = match OutputStream::try_default() {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("Failed to open audio output: {}", e);
                    return;
                }
            };

            // Shuffle bag: plays all sounds before repeating any
            let mut bag: Vec<PathBuf> = Vec::new();
            let mut bag_index: usize = 0;
            let mut bag_source: Vec<PathBuf> = Vec::new();
            let mut bag_order = PlaybackOrder::Random;

            // Single sink — stops previous sound before playing next
            let mut current_sink: Option<Sink> = None;

            loop {
                match cmd_rx.recv() {
                    Ok(cmd) => {
                        if cmd.files.is_empty() {
                            eprintln!("No sound files in the active selection");
                            continue;
                        }

                        // A stable queue supports either an in-order playlist or a shuffle bag.
                        if cmd.files != bag_source || cmd.playback_order != bag_order || bag_index >= bag.len() {
                            bag = cmd.files.clone();
                            if cmd.playback_order == PlaybackOrder::Random {
                                bag.shuffle(&mut rand::rng());
                            }
                            bag_index = 0;
                            bag_source = cmd.files;
                            bag_order = cmd.playback_order;
                        }

                        let file = &bag[bag_index];
                        bag_index += 1;

                        match fs::File::open(file) {
                            Ok(f) => {
                                let reader = BufReader::new(f);
                                match Decoder::new(reader) {
                                    Ok(source) => {
                                        // Stop previous sound
                                        if let Some(old) = current_sink.take() {
                                            old.stop();
                                        }
                                        if let Ok(sink) = Sink::try_new(&stream_handle) {
                                            sink.set_volume(cmd.volume * cmd.intensity);
                                            sink.append(source);
                                            current_sink = Some(sink);
                                        }
                                    }
                                    Err(e) => eprintln!("Failed to decode {:?}: {}", file, e),
                                }
                            }
                            Err(e) => eprintln!("Failed to open {:?}: {}", file, e),
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        PlayerHandle { cmd_tx, sounds_dir }
    }

    pub fn play(&self, bundle: &str, volume: f32, intensity: f32) {
        self.play_selection(&[bundle.to_string()], &[], PlaybackOrder::Random, volume, intensity);
    }

    pub fn play_selection(
        &self,
        categories: &[String],
        selected_sounds: &[SelectedSound],
        playback_order: PlaybackOrder,
        volume: f32,
        intensity: f32,
    ) {
        let files = self.files_for_selection(categories, selected_sounds);
        self.cmd_tx
            .send(PlayCmd {
                files,
                volume,
                intensity,
                playback_order,
            })
            .ok();
    }

    pub fn files_for_selection(
        &self,
        categories: &[String],
        selected_sounds: &[SelectedSound],
    ) -> Vec<PathBuf> {
        let mut files = Vec::new();
        let mut seen = HashSet::new();

        for category in categories {
            for path in list_sounds(&self.sounds_dir.join(category)) {
                if seen.insert(path.clone()) {
                    files.push(path);
                }
            }
        }

        for sound in selected_sounds {
            let path = self.sounds_dir.join(&sound.category).join(&sound.filename);
            if path.is_file() && is_sound_file(&path) && seen.insert(path.clone()) {
                files.push(path);
            }
        }

        files.sort();
        files
    }

    pub fn install_starter_library(&self, source: &std::path::Path) -> Result<(), String> {
        if !source.exists() {
            return Err(format!("Bundled sound library was not found at {:?}", source));
        }
        copy_missing_tree(source, &self.sounds_dir)
    }

    pub fn bundle_has_sounds(&self, bundle: &str) -> bool {
        if bundle.trim().is_empty() {
            return false;
        }

        !list_sounds(&self.sounds_dir.join(bundle)).is_empty()
    }

    // ── Bundle Management ───────────────────────────

    pub fn list_bundles(&self) -> Vec<BundleInfo> {
        let mut bundles = Vec::new();
        if let Ok(entries) = fs::read_dir(&self.sounds_dir) {
            for e in entries.filter_map(|e| e.ok()) {
                if e.path().is_dir() {
                    if let Some(name) = e.file_name().into_string().ok() {
                        let count = list_sounds(&e.path()).len();
                        bundles.push(BundleInfo { name, count });
                    }
                }
            }
        }
        bundles.sort_by(|a, b| a.name.cmp(&b.name));
        bundles
    }

    pub fn create_bundle(&self, name: &str) -> Result<(), String> {
        validate_bundle_name(name)?;
        let dir = self.sounds_dir.join(name);
        if dir.exists() {
            return Err(format!("Bundle '{}' already exists", name));
        }
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create bundle: {}", e))
    }

    pub fn delete_bundle(&self, name: &str) -> Result<(), String> {
        let dir = self.sounds_dir.join(name);
        if !dir.exists() {
            return Err(format!("Bundle '{}' not found", name));
        }
        fs::remove_dir_all(&dir).map_err(|e| format!("Failed to delete bundle: {}", e))
    }

    pub fn rename_bundle(&self, old: &str, new: &str) -> Result<(), String> {
        validate_bundle_name(new)?;
        let old_dir = self.sounds_dir.join(old);
        let new_dir = self.sounds_dir.join(new);
        if !old_dir.exists() {
            return Err(format!("Bundle '{}' not found", old));
        }
        if new_dir.exists() {
            return Err(format!("Bundle '{}' already exists", new));
        }
        fs::rename(&old_dir, &new_dir).map_err(|e| format!("Failed to rename: {}", e))
    }

    // ── Sound File Management ───────────────────────

    pub fn list_bundle_sounds(&self, bundle: &str) -> Vec<SoundInfo> {
        let dir = self.sounds_dir.join(bundle);
        list_sounds(&dir)
            .into_iter()
            .filter_map(|path| {
                path.file_name()
                    .and_then(|n| n.to_str())
                    .map(|name| SoundInfo {
                        name: name.to_string(),
                    })
            })
            .collect()
    }

    pub fn import_sounds(&self, bundle: &str, paths: &[String]) -> Result<Vec<String>, String> {
        let dir = self.sounds_dir.join(bundle);
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;

        let mut imported = Vec::new();
        for path in paths {
            let src = std::path::Path::new(path);
            if let Some(filename) = src.file_name() {
                let dest = dir.join(filename);
                match fs::copy(src, &dest) {
                    Ok(_) => imported.push(filename.to_string_lossy().to_string()),
                    Err(e) => eprintln!("Failed to copy {}: {}", path, e),
                }
            }
        }
        Ok(imported)
    }

    pub fn remove_sound(&self, bundle: &str, filename: &str) -> Result<(), String> {
        let path = self.sounds_dir.join(bundle).join(filename);
        fs::remove_file(&path).map_err(|e| format!("Failed to remove: {}", e))
    }
}

#[derive(serde::Serialize)]
pub struct BundleInfo {
    pub name: String,
    pub count: usize,
}

#[derive(serde::Serialize)]
pub struct SoundInfo {
    pub name: String,
}

/// Reject names that could cause path traversal or contain unsafe characters.
fn validate_bundle_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 50 {
        return Err("Bundle name must be 1-50 characters".to_string());
    }
    let valid = name
        .chars()
        .all(|c| c.is_alphanumeric() || c == ' ' || c == '_' || c == '-');
    if !valid {
        return Err("Bundle name contains invalid characters".to_string());
    }
    Ok(())
}

fn list_sounds(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut sounds = match fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| is_sound_file(p))
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };
    sounds.sort();
    sounds
}

fn is_sound_file(path: &std::path::Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|ext| ext.to_ascii_lowercase()),
        Some(ext) if matches!(ext.as_str(), "wav" | "mp3" | "ogg" | "flac")
    )
}

fn copy_missing_tree(source: &std::path::Path, destination: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| format!("Failed to create sound library: {e}"))?;
    for entry in fs::read_dir(source).map_err(|e| format!("Failed to read starter library: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read starter library entry: {e}"))?;
        let target = destination.join(entry.file_name());
        if entry.path().is_dir() {
            copy_missing_tree(&entry.path(), &target)?;
        } else if !target.exists() {
            fs::copy(entry.path(), target).map_err(|e| format!("Failed to install starter sound: {e}"))?;
        }
    }
    Ok(())
}
