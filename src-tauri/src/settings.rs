use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager as _;

use crate::detector::DetectionMode;
use crate::ports::{repair_rules, PortKind, PortRule};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    System,
    Light,
    Dark,
}

impl Default for ThemePreference {
    fn default() -> Self {
        Self::System
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectedSound {
    pub category: String,
    pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sensitivity: f32,
    pub microphone_sensitivity: f32,
    pub accelerometer_sensitivity: f32,
    pub cooldown_ms: u64,
    pub volume: f32,
    #[serde(default = "default_true")]
    pub use_system_volume: bool,
    pub enabled: bool,
    pub detection_mode: DetectionMode,
    /// Kept for backwards compatibility with existing settings and port rules.
    pub bundle: String,
    pub selected_categories: Vec<String>,
    pub selected_sounds: Vec<SelectedSound>,
    pub album_order: Vec<String>,
    /// Prevents a future launch from deleting a user-created pack that happens
    /// to use one of the names from the original starter library.
    pub legacy_starter_library_removed: bool,
    pub nsfw_enabled: bool,
    pub theme: ThemePreference,
    pub port_rules: Vec<PortRule>,
    pub hide_support_prompt: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sensitivity: 0.15,
            microphone_sensitivity: 0.15,
            accelerometer_sensitivity: 0.15,
            cooldown_ms: 2000,
            volume: 0.8,
            use_system_volume: true,
            enabled: false,
            detection_mode: DetectionMode::Microphone,
            bundle: String::new(),
            selected_categories: Vec::new(),
            selected_sounds: Vec::new(),
            album_order: vec![
                "Trendy".to_string(),
                "OG".to_string(),
                "OG-Indian".to_string(),
                "TV".to_string(),
                "Moan".to_string(),
                "Chodu CID".to_string(),
            ],
            legacy_starter_library_removed: false,
            nsfw_enabled: false,
            theme: ThemePreference::System,
            port_rules: PortKind::all()
                .into_iter()
                .map(PortRule::default_for)
                .collect(),
            hide_support_prompt: false,
        }
    }
}

impl Settings {
    pub fn config_path(app_handle: &tauri::AppHandle) -> PathBuf {
        let dir = app_handle
            .path()
            .app_config_dir()
            .expect("failed to get config dir");
        fs::create_dir_all(&dir).ok();
        dir.join("settings.json")
    }

    pub fn load(app_handle: &tauri::AppHandle) -> Self {
        let path = Self::config_path(app_handle);
        match fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, app_handle: &tauri::AppHandle) {
        let path = Self::config_path(app_handle);
        if let Ok(json) = serde_json::to_string_pretty(self) {
            fs::write(path, json).ok();
        }
    }

    pub fn validate(&mut self) {
        self.sensitivity = self.sensitivity.clamp(0.01, 1.0);
        // Existing installations only have `sensitivity`; use it to seed the
        // per-input controls introduced in the sound-library redesign.
        if self.microphone_sensitivity <= 0.0 {
            self.microphone_sensitivity = self.sensitivity;
        }
        if self.accelerometer_sensitivity <= 0.0 {
            self.accelerometer_sensitivity = self.sensitivity;
        }
        self.microphone_sensitivity = self.microphone_sensitivity.clamp(0.01, 1.0);
        self.accelerometer_sensitivity = self.accelerometer_sensitivity.clamp(0.01, 1.0);
        self.sensitivity = self.microphone_sensitivity;
        self.cooldown_ms = self.cooldown_ms.clamp(200, 10000);
        self.volume = self.volume.clamp(0.0, 1.0);

        if !matches!(
            self.detection_mode,
            DetectionMode::Microphone | DetectionMode::Accelerometer
        ) {
            self.detection_mode = DetectionMode::Microphone;
        }

        repair_rules(&mut self.port_rules);

        if !self.nsfw_enabled {
            self.selected_categories.retain(|category| !is_nsfw_category(category));
            self.selected_sounds
                .retain(|sound| !is_nsfw_category(&sound.category));
        }
    }

    pub fn detection_threshold(&self) -> f32 {
        match self.detection_mode {
            DetectionMode::Microphone => self.microphone_sensitivity,
            DetectionMode::Accelerometer => self.accelerometer_sensitivity,
        }
    }

    pub fn output_volume(&self) -> f32 {
        if self.use_system_volume {
            1.0
        } else {
            self.volume
        }
    }
}

pub fn is_nsfw_category(category: &str) -> bool {
    category.eq_ignore_ascii_case("Moan")
        || category.eq_ignore_ascii_case("Chodu CID")
        // Retain the legacy names here so a stale setting cannot expose them.
        || category.eq_ignore_ascii_case("After Dark")
        || category.eq_ignore_ascii_case("NSFW")
}

fn default_true() -> bool {
    true
}
