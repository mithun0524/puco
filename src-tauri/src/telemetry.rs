//! Telemetry engine: one background thread polls sysinfo + battery at 1 Hz,
//! emits a `telemetry` event, and raises debounced `alert`s.
//! The `System` lives behind a mutex so commands (kill) can reuse its process table.

use serde::Serialize;
use std::{
    cmp::Ordering,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use sysinfo::{
    Components, MemoryRefreshKind, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind,
};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

pub type SharedSys = Arc<Mutex<System>>;

const TICK: Duration = Duration::from_secs(1);

#[derive(Serialize, Clone, Debug)]
pub struct Proc {
    pub pid: u32,
    pub name: String,
    /// Percent of *total* machine CPU (normalised by core count).
    pub cpu: f32,
    pub mem: u64,
    pub exe: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct Battery {
    pub pct: f32,
    pub charging: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    /// None when the OS exposes no readable sensor (common on Windows without admin/WMI).
    pub temp: Option<f32>,
    pub battery: Option<Battery>,
    pub top_cpu: Vec<Proc>,
    pub top_mem: Vec<Proc>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Alert {
    pub title: String,
    pub body: String,
    pub level: &'static str,
    /// Which metric the alert is about ("cpu" | "mem" | "battery"), so the island can show its live value.
    pub kind: &'static str,
}

pub fn spawn(app: AppHandle) -> SharedSys {
    let sys: SharedSys = Arc::new(Mutex::new(System::new().expect("sysinfo unsupported on this OS")));
    let shared = sys.clone();
    thread::Builder::new()
        .name("telemetry".into())
        .spawn(move || poll(app, shared))
        .expect("spawn telemetry thread");
    sys
}

fn poll(app: AppHandle, sys: SharedSys) {
    // Sensors are optional: some platforms/VMs expose none.
    let mut comps = Components::new_with_refreshed_list().ok();
    let batteries = starship_battery::Manager::new().ok();
    let me = sysinfo::get_current_pid().ok();
    let mut alerts = Alerts::new();
    let mut s = Sample::default();

    for tick in 0u64.. {
        let started = Instant::now();
        {
            // Hold the lock only for the refresh itself; never across emit/sleep.
            let mut sys = sys.lock().unwrap_or_else(|e| e.into_inner());
            sys.refresh_cpu_usage();
            sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
            s.cpu = sys.global_cpu_usage();
            s.mem_used = sys.used_memory();
            s.mem_total = sys.total_memory();

            // Process table is the expensive part: every 2 s is plenty for a top-3.
            if tick % 2 == 0 {
                sys.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    true,
                    ProcessRefreshKind::nothing()
                        .with_cpu()
                        .with_memory()
                        .with_exe(UpdateKind::OnlyIfNotSet),
                );
                let cores = sys.cpus().len().max(1) as f32;
                let mut all: Vec<Proc> = sys
                    .processes()
                    .values()
                    .filter(|p| Some(p.pid()) != me && p.thread_kind().is_none())
                    .map(|p| Proc {
                        pid: p.pid().as_u32(),
                        name: p.name().to_string_lossy().into_owned(),
                        cpu: p.cpu_usage() / cores,
                        mem: p.memory(),
                        exe: p.exe().map(|e| e.display().to_string()),
                    })
                    .collect();
                s.top_cpu = top3(&mut all, |a, b| b.cpu.total_cmp(&a.cpu));
                s.top_mem = top3(&mut all, |a, b| b.mem.cmp(&a.mem));
            }
        }
        if tick % 3 == 0 {
            s.temp = comps.as_mut().and_then(|c| {
                c.refresh(false);
                cpu_temp(c)
            });
        }
        if tick % 10 == 0 {
            s.battery = batteries.as_ref().and_then(read_battery);
        }

        for a in alerts.check(Instant::now(), &s) {
            let _ = app.notification().builder().title(&a.title).body(&a.body).show();
            let _ = app.emit("alert", &a);
        }
        let _ = app.emit("telemetry", &s);
        thread::sleep(TICK.saturating_sub(started.elapsed()));
    }
}

fn top3(v: &mut [Proc], cmp: impl Fn(&Proc, &Proc) -> Ordering) -> Vec<Proc> {
    v.sort_unstable_by(cmp);
    v.iter().take(3).cloned().collect()
}

/// Hottest CPU-ish sensor; falls back to hottest sensor of any kind.
fn cpu_temp(comps: &Components) -> Option<f32> {
    let readings: Vec<(String, f32)> = comps
        .iter()
        .filter_map(|c| Some((c.label().to_lowercase(), c.temperature()?)))
        .filter(|(_, t)| *t > 0.0 && *t < 130.0)
        .collect();
    let max = |it: &mut dyn Iterator<Item = f32>| it.reduce(f32::max);
    const CPU: [&str; 7] = ["cpu", "core", "package", "tdie", "tctl", "soc", "pmu"];
    max(&mut readings
        .iter()
        .filter(|(l, _)| CPU.iter().any(|k| l.contains(k)))
        .map(|(_, t)| *t))
    .or_else(|| max(&mut readings.iter().map(|(_, t)| *t)))
}

fn read_battery(m: &starship_battery::Manager) -> Option<Battery> {
    use starship_battery::State;
    let b = m.batteries().ok()?.flatten().next()?;
    Some(Battery {
        pct: b.state_of_charge().value * 100.0,
        charging: matches!(b.state(), State::Charging | State::Full),
    })
}

/// Edge-triggered alerts with hysteresis so nothing spams.
struct Alerts {
    cpu_since: Option<Instant>,
    cpu_fired: bool,
    mem_fired: bool,
    low_fired: bool,
    full_fired: bool,
}

impl Alerts {
    fn new() -> Self {
        // full_fired starts true: no "fully charged" chirp just because we launched at 100%.
        Self { cpu_since: None, cpu_fired: false, mem_fired: false, low_fired: false, full_fired: true }
    }

    fn check(&mut self, now: Instant, s: &Sample) -> Vec<Alert> {
        let mut out = Vec::new();
        let mut push = |kind, title: &str, body: String, level| {
            out.push(Alert { title: title.into(), body, level, kind })
        };

        if s.cpu > 85.0 {
            let since = *self.cpu_since.get_or_insert(now);
            if !self.cpu_fired && now.duration_since(since) >= Duration::from_secs(15) {
                self.cpu_fired = true;
                let hog = s.top_cpu.first().map(|p| format!(" Top hog: {}.", p.name)).unwrap_or_default();
                push("cpu", "Sustained CPU spike", format!("CPU above 85% for 15s ({:.0}%).{hog}", s.cpu), "hot");
            }
        } else {
            self.cpu_since = None;
            if s.cpu < 70.0 {
                self.cpu_fired = false;
            }
        }

        if s.mem_total > 0 {
            let pct = s.mem_used as f64 / s.mem_total as f64 * 100.0;
            if pct > 90.0 && !self.mem_fired {
                self.mem_fired = true;
                push("mem", "Memory almost full", format!("RAM at {pct:.0}%."), "hot");
            } else if pct < 85.0 {
                self.mem_fired = false;
            }
        }

        if let Some(b) = s.battery {
            if !b.charging && b.pct < 20.0 && !self.low_fired {
                self.low_fired = true;
                push("battery", "Battery low", format!("{:.0}% left. Plug in soon.", b.pct), "warn");
            } else if b.charging || b.pct > 25.0 {
                self.low_fired = false;
            }
            if b.charging && b.pct >= 99.5 && !self.full_fired {
                self.full_fired = true;
                push("battery", "Fully charged", "100% — unplug whenever you like.".into(), "info");
            } else if b.pct < 95.0 {
                self.full_fired = false;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(cpu: f32, mem: u64, battery: Option<(f32, bool)>) -> Sample {
        Sample {
            cpu,
            mem_used: mem,
            mem_total: 100,
            battery: battery.map(|(pct, charging)| Battery { pct, charging }),
            ..Default::default()
        }
    }

    #[test]
    fn alerts_fire_once_with_hysteresis() {
        let mut a = Alerts::new();
        let t0 = Instant::now();
        let at = |s| t0 + Duration::from_secs(s);

        // CPU: needs 15 s sustained, fires once, re-arms only below 70%.
        assert!(a.check(at(0), &sample(90.0, 10, None)).is_empty());
        assert!(a.check(at(14), &sample(90.0, 10, None)).is_empty());
        assert_eq!(a.check(at(15), &sample(90.0, 10, None)).len(), 1);
        assert!(a.check(at(40), &sample(90.0, 10, None)).is_empty());
        a.check(at(41), &sample(80.0, 10, None)); // dip but not re-armed
        assert!(a.check(at(57), &sample(90.0, 10, None)).is_empty());
        a.check(at(58), &sample(50.0, 10, None)); // re-arm
        a.check(at(59), &sample(90.0, 10, None));
        assert_eq!(a.check(at(74), &sample(90.0, 10, None)).len(), 1);

        // Memory: >90 fires once, re-arms below 85.
        assert_eq!(a.check(at(100), &sample(0.0, 95, None)).len(), 1);
        assert!(a.check(at(101), &sample(0.0, 88, None)).is_empty());
        assert!(a.check(at(102), &sample(0.0, 95, None)).is_empty());

        // Battery: low once while discharging; no full chirp at launch; chirp after a real charge.
        assert_eq!(a.check(at(200), &sample(0.0, 10, Some((15.0, false)))).len(), 1);
        assert!(a.check(at(201), &sample(0.0, 10, Some((14.0, false)))).is_empty());
        assert_eq!(a.check(at(202), &sample(0.0, 10, Some((100.0, true)))).len(), 1);
    }

    #[test]
    fn no_full_chirp_on_launch() {
        let mut a = Alerts::new();
        assert!(a.check(Instant::now(), &sample(0.0, 10, Some((100.0, true)))).is_empty());
    }
}
