//! In-app updates from GitHub Releases, through `tauri-plugin-updater`.
//!
//! The release workflow publishes a signed `latest.json` next to the
//! installers. The app checks it, asks the user, downloads the new installer
//! in the background (progress is polled through [`Updates::status`], like
//! the SoundFont download), and installs it when the user restarts.
//!
//! Every package is verified against the public key in `tauri.conf.json`
//! before it is installed.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

/// What the updater is doing, as seen by the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UpdateStatus {
    Idle,
    Checking,
    UpToDate {
        current: String,
    },
    Available(UpdateInfo),
    Downloading {
        version: String,
        received: u64,
        total: u64,
    },
    /// Downloaded and verified; installed when the user restarts.
    Ready {
        version: String,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    /// Release notes (Markdown) from the GitHub Release.
    pub notes: String,
    /// Publication date, `YYYY-MM-DD`.
    pub date: Option<String>,
}

#[derive(Default)]
struct Inner {
    status: Option<UpdateStatus>,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

/// Shared updater state, kept in `AppState`.
#[derive(Default, Clone)]
pub struct Updates {
    inner: Arc<Mutex<Inner>>,
}

impl Updates {
    pub fn status(&self) -> UpdateStatus {
        self.inner
            .lock()
            .unwrap()
            .status
            .clone()
            .unwrap_or(UpdateStatus::Idle)
    }

    fn set_status(&self, status: UpdateStatus) {
        self.inner.lock().unwrap().status = Some(status);
    }

    fn busy(&self) -> bool {
        matches!(
            self.status(),
            UpdateStatus::Checking | UpdateStatus::Downloading { .. } | UpdateStatus::Ready { .. }
        )
    }

    /// Asks GitHub whether a newer version exists.
    pub async fn check(&self, app: &AppHandle) -> UpdateStatus {
        if self.busy() {
            return self.status();
        }
        self.set_status(UpdateStatus::Checking);
        let result = match app.updater() {
            Ok(updater) => updater.check().await,
            Err(e) => Err(e),
        };
        let status = match result {
            Ok(Some(update)) => {
                let info = UpdateInfo {
                    version: update.version.clone(),
                    current: update.current_version.clone(),
                    notes: update.body.clone().unwrap_or_default(),
                    date: update.date.map(|d| d.date().to_string()),
                };
                self.inner.lock().unwrap().update = Some(update);
                UpdateStatus::Available(info)
            }
            Ok(None) => UpdateStatus::UpToDate {
                current: app.package_info().version.to_string(),
            },
            Err(e) => UpdateStatus::Error {
                message: e.to_string(),
            },
        };
        self.set_status(status.clone());
        status
    }

    /// Downloads and verifies the update found by [`Updates::check`] in the
    /// background. Progress shows up in [`Updates::status`].
    pub fn download(&self) -> Result<(), String> {
        let update = {
            let inner = self.inner.lock().unwrap();
            if matches!(
                inner.status,
                Some(UpdateStatus::Downloading { .. } | UpdateStatus::Ready { .. })
            ) {
                return Ok(());
            }
            inner.update.clone().ok_or("No update to download")?
        };
        let version = update.version.clone();
        self.set_status(UpdateStatus::Downloading {
            version: version.clone(),
            received: 0,
            total: 0,
        });
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut received = 0u64;
            let progress = this.clone();
            let v = version.clone();
            let result = update
                .download(
                    move |chunk, total| {
                        received += chunk as u64;
                        progress.set_status(UpdateStatus::Downloading {
                            version: v.clone(),
                            received,
                            total: total.unwrap_or(0),
                        });
                    },
                    || {},
                )
                .await;
            match result {
                Ok(bytes) => {
                    let mut inner = this.inner.lock().unwrap();
                    inner.bytes = Some(bytes);
                    inner.status = Some(UpdateStatus::Ready { version });
                }
                Err(e) => this.set_status(UpdateStatus::Error {
                    message: e.to_string(),
                }),
            }
        });
        Ok(())
    }

    /// Installs the downloaded update. On Windows the installer takes over
    /// and the app exits; elsewhere the caller restarts the app.
    pub fn install(&self) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        let (Some(update), Some(bytes)) = (inner.update.as_ref(), inner.bytes.as_ref()) else {
            return Err("The update has not been downloaded yet".into());
        };
        update.install(bytes).map_err(|e| e.to_string())
    }
}
