//! Registers the app's MCP server with Claude Code by editing Claude Code's
//! own config file, which is what `claude mcp add` does from a terminal.
//!
//! Claude Code keeps user-scope servers in `~/.claude.json` under
//! `mcpServers`, one entry per name. The app writes one entry, `to-hoot`, and
//! leaves everything else in the file exactly as it found it: the file also
//! holds the person's other servers, their preferences and their project
//! list, none of which is the app's business.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{Map, Value};

const FILE: &str = ".claude.json";
const KEY: &str = "mcpServers";

/// What the settings screen shows: whether the entry is there, and what it
/// points at if so.
#[derive(Serialize)]
pub struct Entry {
    pub path: String,
    pub present: bool,
    /// The `url` of an http entry or the `command` of a stdio one.
    pub target: Option<String>,
}

fn config_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| "no home directory to find Claude Code's config in".to_string())?;
    Ok(PathBuf::from(home).join(FILE))
}

/// The file with one server set. An absent or empty file is an empty object;
/// anything that is not a JSON object is refused rather than overwritten,
/// because a file Claude Code cannot read is worse than a server it lacks.
pub fn with_server(existing: &str, name: &str, server: Value) -> Result<String, String> {
    let mut root: Value = if existing.trim().is_empty() {
        Value::Object(Map::new())
    } else {
        serde_json::from_str(existing).map_err(|err| format!("Claude Code's config is not valid JSON: {err}"))?
    };
    let Value::Object(map) = &mut root else {
        return Err("Claude Code's config is not a JSON object".to_string());
    };
    let servers = map.entry(KEY).or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(servers) = servers else {
        return Err(format!("`{KEY}` in Claude Code's config is not an object"));
    };
    servers.insert(name.to_string(), server);
    serde_json::to_string_pretty(&root).map_err(|err| err.to_string())
}

/// What the file says about one server, without changing anything.
pub fn entry_in(existing: &str, name: &str) -> (bool, Option<String>) {
    let Ok(root) = serde_json::from_str::<Value>(existing) else {
        return (false, None);
    };
    let Some(server) = root.get(KEY).and_then(|s| s.get(name)) else {
        return (false, None);
    };
    let target = server
        .get("url")
        .or_else(|| server.get("command"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    (true, target)
}

/// Adds or replaces the `to-hoot` entry and answers with the file it wrote.
#[tauri::command]
pub fn claude_code_add(name: String, server: Value) -> Result<String, String> {
    let path = config_path()?;
    let existing = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(format!("could not read {}: {err}", path.display())),
    };
    let next = with_server(&existing, &name, server)?;
    // Written beside the file and renamed over it, so a crash mid-write
    // leaves the old file whole rather than a truncated one.
    let temp = path.with_extension("json.to-hoot-tmp");
    fs::write(&temp, next).map_err(|err| format!("could not write {}: {err}", temp.display()))?;
    fs::rename(&temp, &path).map_err(|err| format!("could not replace {}: {err}", path.display()))?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn claude_code_inspect(name: String) -> Result<Entry, String> {
    let path = config_path()?;
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let (present, target) = entry_in(&existing, &name);
    Ok(Entry { path: path.display().to_string(), present, target })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn adds_the_server_and_keeps_everything_else() {
        let before = r#"{"numStartups": 3, "mcpServers": {"other": {"type": "stdio", "command": "x"}}, "projects": {}}"#;
        let after = with_server(before, "to-hoot", json!({"type": "http", "url": "https://x.workers.dev/mcp/s"})).unwrap();
        let parsed: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(parsed["numStartups"], 3);
        assert_eq!(parsed["mcpServers"]["other"]["command"], "x");
        assert_eq!(parsed["mcpServers"]["to-hoot"]["url"], "https://x.workers.dev/mcp/s");
        assert!(parsed.get("projects").is_some());
    }

    #[test]
    fn starts_from_nothing_and_replaces_an_old_entry() {
        let first = with_server("", "to-hoot", json!({"type": "stdio", "command": "node"})).unwrap();
        let second = with_server(&first, "to-hoot", json!({"type": "http", "url": "https://y"})).unwrap();
        let parsed: Value = serde_json::from_str(&second).unwrap();
        assert_eq!(parsed["mcpServers"]["to-hoot"]["type"], "http");
        assert!(parsed["mcpServers"]["to-hoot"].get("command").is_none());
        assert_eq!(entry_in(&second, "to-hoot"), (true, Some("https://y".to_string())));
        assert_eq!(entry_in(&second, "other"), (false, None));
    }

    #[test]
    fn refuses_to_overwrite_a_file_it_cannot_read() {
        assert!(with_server("not json", "to-hoot", json!({})).is_err());
        assert!(with_server("[1,2]", "to-hoot", json!({})).is_err());
        assert!(with_server(r#"{"mcpServers": 5}"#, "to-hoot", json!({})).is_err());
    }
}
