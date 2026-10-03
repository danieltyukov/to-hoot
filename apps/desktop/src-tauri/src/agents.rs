//! Registers the app's MCP server with the agents on this computer, by editing
//! each agent's own config file, which is what its `mcp add` command does from
//! a terminal.
//!
//! This side owns *where*: an agent id resolves to one file and its format, so
//! the webview can only ever name a file on this list. The webview owns
//! *what*: the key the servers live under and the shape of one entry, because
//! it also renders the same entry as a snippet for anyone who would rather
//! paste it.
//!
//! The app writes one entry and leaves everything else in the file exactly as
//! it found it. These files also hold the person's other servers, their
//! preferences and their project history, none of which is the app's business.
//! A file that does not parse is refused rather than overwritten: a config the
//! agent cannot read is worse than a server it lacks.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Runtime};

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
    /// A folder whose presence says the agent is installed here.
    pub marker: PathBuf,
}

impl Agent {
    pub fn location(self, dirs: &Dirs) -> Location {
        let home = &dirs.home;
        let json = |file: PathBuf, marker: PathBuf| Location { file, format: Format::Json, marker };
        match self {
            Agent::ClaudeCode => json(home.join(".claude.json"), home.join(".claude")),
            Agent::Codex => {
                let dir = dirs.codex_home.clone().unwrap_or_else(|| home.join(".codex"));
                Location { file: dir.join("config.toml"), format: Format::Toml, marker: dir }
            }
            Agent::GeminiCli => json(home.join(".gemini").join("settings.json"), home.join(".gemini")),
            Agent::Cursor => json(home.join(".cursor").join("mcp.json"), home.join(".cursor")),
            Agent::VsCode => {
                let user = dirs.config.join("Code").join("User");
                json(user.join("mcp.json"), dirs.config.join("Code"))
            }
            Agent::Windsurf => {
                let dir = home.join(".codeium").join("windsurf");
                json(dir.join("mcp_config.json"), dir)
            }
            Agent::Opencode => {
                let dir = dirs.xdg_config.clone().unwrap_or_else(|| home.join(".config")).join("opencode");
                json(dir.join("opencode.json"), dir)
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
    for key in ["url", "httpUrl", "serverUrl"] {
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

/// The file with one server set, for a JSON config. An absent or empty file is
/// an empty object.
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
    servers.insert(name.to_string(), server);
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

/// The file with one server set, for Codex's `config.toml`. `toml_edit` keeps
/// the rest of the document as it was written, comments and order included.
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
    let toml_edit::Item::Table(entry) = toml_item(server)? else {
        return Err("a server entry has to be a table".to_string());
    };
    servers.insert(name, toml_edit::Item::Table(entry));
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
/// The new file keeps the old one's permissions, and a file that did not exist
/// is created readable by its owner only: what goes in it is an endpoint URL or
/// a GitHub token, both of which are credentials.
fn replace_file(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("could not create {}: {err}", parent.display()))?;
    }
    let mut temp_name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    temp_name.push(".to-hoot-tmp");
    let temp = path.with_file_name(temp_name);
    fs::write(&temp, contents).map_err(|err| format!("could not write {}: {err}", temp.display()))?;
    match fs::metadata(path) {
        Ok(meta) => {
            let _ = fs::set_permissions(&temp, meta.permissions());
        }
        Err(_) => owner_only(&temp),
    }
    fs::rename(&temp, path).map_err(|err| {
        let _ = fs::remove_file(&temp);
        format!("could not replace {}: {err}", path.display())
    })
}

#[cfg(unix)]
fn owner_only(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn owner_only(_path: &Path) {}

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
    /// Whether the file already has an entry under this name.
    pub present: bool,
    pub target: Option<String>,
}

#[tauri::command]
pub fn agent_inspect<R: Runtime>(app: AppHandle<R>, agent: Agent, key: String, name: String) -> Result<Entry, String> {
    let location = agent.location(&dirs(&app)?);
    let existing = fs::read_to_string(&location.file).unwrap_or_default();
    let entry = match location.format {
        Format::Json => json_entry(&existing, &key, &name),
        Format::Toml => toml_entry(&existing, &key, &name),
    };
    Ok(Entry {
        path: location.file.display().to_string(),
        installed: location.marker.exists() || location.file.exists(),
        present: entry.is_some(),
        target: entry.as_ref().and_then(target_of),
    })
}

/// Adds or replaces one entry and answers with the file it wrote.
#[tauri::command]
pub fn agent_add<R: Runtime>(
    app: AppHandle<R>,
    agent: Agent,
    key: String,
    name: String,
    entry: Value,
) -> Result<String, String> {
    let location = agent.location(&dirs(&app)?);
    let existing = read_existing(&location.file)?;
    let next = match location.format {
        Format::Json => json_with_server(&existing, &key, &name, entry)?,
        Format::Toml => toml_with_server(&existing, &key, &name, &entry)?,
    };
    replace_file(&location.file, &next)?;
    Ok(location.file.display().to_string())
}

/// Where the local server was put, and the node that can run it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServer {
    pub path: String,
    pub node: Option<String>,
    pub node_version: Option<String>,
}

pub const SERVER_FILE: &str = "to-hoot-mcp.mjs";

/// Writes the bundled stdio server into the app's data folder and finds a node
/// to run it with. The webview downloads the bundle for its own version; this
/// side only puts it somewhere stable and answers with the absolute path.
#[tauri::command]
pub fn agent_server_install<R: Runtime>(app: AppHandle<R>, source: String) -> Result<LocalServer, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("no data directory: {err}"))?
        .join("mcp");
    let path = dir.join(SERVER_FILE);
    replace_file(&path, &source)?;
    let home = dirs(&app)?.home;
    let node = find_node(std::env::var_os("PATH"), &home);
    let node_version = node.as_deref().and_then(node_version);
    Ok(LocalServer {
        path: path.display().to_string(),
        node: node.map(|p| p.display().to_string()),
        node_version,
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

    #[test]
    fn every_agent_has_a_file_under_home_or_config() {
        let d = test_dirs();
        let file = |a: Agent| a.location(&d).file;
        assert_eq!(file(Agent::ClaudeCode), PathBuf::from("/home/u/.claude.json"));
        assert_eq!(file(Agent::Codex), PathBuf::from("/home/u/.codex/config.toml"));
        assert_eq!(Agent::Codex.location(&d).format, Format::Toml);
        assert_eq!(file(Agent::GeminiCli), PathBuf::from("/home/u/.gemini/settings.json"));
        assert_eq!(file(Agent::Cursor), PathBuf::from("/home/u/.cursor/mcp.json"));
        assert_eq!(file(Agent::VsCode), PathBuf::from("/home/u/.config/Code/User/mcp.json"));
        assert_eq!(file(Agent::Windsurf), PathBuf::from("/home/u/.codeium/windsurf/mcp_config.json"));
        assert_eq!(file(Agent::Opencode), PathBuf::from("/home/u/.config/opencode/opencode.json"));
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
    fn json_adds_the_server_and_keeps_everything_else() {
        let before = r#"{"numStartups": 3, "mcpServers": {"other": {"type": "stdio", "command": "x"}}, "projects": {}}"#;
        let after = json_with_server(before, "mcpServers", "to-hoot", json!({"type": "http", "url": "https://x.workers.dev/mcp/s"})).unwrap();
        let parsed: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(parsed["numStartups"], 3);
        assert_eq!(parsed["mcpServers"]["other"]["command"], "x");
        assert_eq!(parsed["mcpServers"]["to-hoot"]["url"], "https://x.workers.dev/mcp/s");
        assert!(parsed.get("projects").is_some());
    }

    #[test]
    fn json_starts_from_nothing_and_replaces_an_old_entry() {
        let first = json_with_server("", "servers", "to-hoot", json!({"type": "stdio", "command": "node"})).unwrap();
        let second = json_with_server(&first, "servers", "to-hoot", json!({"type": "http", "url": "https://y"})).unwrap();
        let entry = json_entry(&second, "servers", "to-hoot").unwrap();
        assert_eq!(entry["type"], "http");
        assert!(entry.get("command").is_none());
        assert_eq!(target_of(&entry).as_deref(), Some("https://y"));
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
            &json!({"command": "/usr/bin/node", "args": ["/data/to-hoot-mcp.mjs"], "env": {"TO_HOOT_GITHUB_OWNER": "me"}}),
        )
        .unwrap();
        assert!(after.starts_with("# my settings\nmodel = \"o4\"\n"));
        assert!(after.contains("[mcp_servers.other]\ncommand = \"x\""));
        assert!(after.contains("[mcp_servers.to-hoot]"));
        assert!(after.contains("[mcp_servers.to-hoot.env]\nTO_HOOT_GITHUB_OWNER = \"me\""));
        assert!(!after.contains("\n[mcp_servers]\n"));
        let entry = toml_entry(&after, "mcp_servers", "to-hoot").unwrap();
        assert_eq!(target_of(&entry).as_deref(), Some("/usr/bin/node"));
    }

    #[test]
    fn toml_replaces_an_old_entry_and_starts_from_nothing() {
        let first = toml_with_server("", "mcp_servers", "to-hoot", &json!({"command": "node"})).unwrap();
        assert!(!first.contains("\n[mcp_servers]\n") && !first.starts_with("[mcp_servers]\n"));
        let second = toml_with_server(&first, "mcp_servers", "to-hoot", &json!({"url": "https://z"})).unwrap();
        assert!(!second.contains("command"));
        let entry = toml_entry(&second, "mcp_servers", "to-hoot").unwrap();
        assert_eq!(target_of(&entry).as_deref(), Some("https://z"));
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
    fn replace_file_creates_folders_and_keeps_the_old_permissions() {
        let dir = std::env::temp_dir().join(format!("to-hoot-agents-{}", std::process::id()));
        let path = dir.join("nested").join("mcp.json");
        replace_file(&path, "{}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
            replace_file(&path, "{\"a\":1}").unwrap();
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
        }
        assert!(!dir.join("nested").join("mcp.json.to-hoot-tmp").exists());
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
