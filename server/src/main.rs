// modified
use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tower_http::{cors::CorsLayer, services::ServeDir};
use walkdir::WalkDir;

// --- State & Types ---

#[derive(Clone)]
struct AppState {
    repo_root: PathBuf,
    checklist_path: PathBuf,
    checklist: Arc<RwLock<BTreeMap<String, ChecklistItem>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChecklistItem {
    status: String,
    note: String,
    updated_ts: u64,
}

#[derive(Debug, Serialize, PartialEq)]
struct SearchResult {
    file: String,
    line: usize,
    column: usize,
    preview: String,
}

#[derive(Deserialize)]
struct SearchParams {
    q: String,
    regex: Option<bool>,
    glob: Option<String>,
}

#[derive(Deserialize)]
struct FileParams {
    path: String,
}

#[derive(Serialize)]
struct FileResponse {
    content: String,
    etag: String,
}

#[derive(Deserialize)]
struct SaveRequest {
    path: String,
    content: String,
    etag: String,
}

#[derive(Deserialize)]
struct PatchChecklist {
    path: String,
    status: Option<String>,
    note: Option<String>,
}

// --- Logic (Decoupled from Axum for testing) ---

fn perform_search(root: &Path, query: &str, use_regex: bool, glob: Option<&str>) -> Vec<SearchResult> {
    let mut results = Vec::new();
    
    let re = if use_regex {
        regex::RegexBuilder::new(query).case_insensitive(true).build().ok()
    } else { None };
    let query_lower = query.to_ascii_lowercase();

    // Normalize glob
    let glob_pattern = glob.map(|g| g.trim_start_matches('*'));

    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() { continue; }

        // --- Robust Filtering ---
        // Don't use .contains("string") on the full path, it breaks if your parent folder is named "target_app"
        // check path components instead.
        let components: Vec<_> = entry.path().components().map(|c| c.as_os_str().to_string_lossy()).collect();
        if components.iter().any(|c| c == ".git" || c == "node_modules" || c == "target" || c == "dist" || c == "codeedit") {
            continue;
        }

        let path_str = entry.path().to_string_lossy();
        if let Some(g) = glob_pattern {
            if !path_str.ends_with(g) { continue; }
        }

        let rel_path = entry.path().strip_prefix(root).unwrap_or(entry.path())
            .to_string_lossy().to_string();
        let rel_path_lower = rel_path.to_ascii_lowercase();

        // 1. Match Filename/Path
        let mut path_matched = false;
        if let Some(ref r) = re {
            if r.is_match(&rel_path) { path_matched = true; }
        } else {
            if rel_path_lower.contains(&query_lower) { path_matched = true; }
        }

        if path_matched {
            results.push(SearchResult {
                file: rel_path.clone(),
                line: 1,
                column: 1,
                preview: format!("FILENAME MATCH: {}", rel_path),
            });
        }

        // 2. Match Content
        // Skip binary check for performance in test, but keep in prod
        let Ok(content) = std::fs::read(entry.path()) else { continue };
        if is_binary(&content) { continue; }
        
        let text = String::from_utf8_lossy(&content);

        for (i, line) in text.lines().enumerate() {
            let (found, col) = if let Some(ref r) = re {
                if let Some(m) = r.find(line) { (true, m.start()) } else { (false, 0) }
            } else {
                match line.to_ascii_lowercase().find(&query_lower) {
                    Some(idx) => (true, idx),
                    None => (false, 0)
                }
            };

            if found {
                results.push(SearchResult {
                    file: rel_path.clone(),
                    line: i + 1,
                    column: col + 1,
                    preview: line.trim().chars().take(200).collect(),
                });
                if results.len() > 2000 { break; }
            }
        }
        if results.len() > 2000 { break; }
    }

    results
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn generate_etag(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn safe_path(root: &Path, rel: &str) -> anyhow::Result<PathBuf> {
    if rel.contains("..") { return Err(anyhow::anyhow!("Invalid path")); }
    Ok(root.join(rel))
}

fn is_binary(data: &[u8]) -> bool {
    data.iter().take(8192).any(|&b| b == 0)
}

// --- Handlers ---

async fn search(
    State(state): State<AppState>,
    Query(params): Query<SearchParams>,
) -> Json<Vec<SearchResult>> {
    let results = perform_search(
        &state.repo_root, 
        &params.q, 
        params.regex.unwrap_or(false), 
        params.glob.as_deref()
    );
    Json(results)
}

async fn get_file(
    State(state): State<AppState>,
    Query(params): Query<FileParams>,
) -> Result<Json<FileResponse>, StatusCode> {
    let path = safe_path(&state.repo_root, &params.path).map_err(|_| StatusCode::BAD_REQUEST)?;
    match std::fs::read(&path) {
        Ok(bytes) => {
            if is_binary(&bytes) { return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE); }
            Ok(Json(FileResponse {
                etag: generate_etag(&bytes),
                content: String::from_utf8_lossy(&bytes).to_string(),
            }))
        },
        Err(_) => Err(StatusCode::NOT_FOUND),
    }
}

async fn save_file(
    State(state): State<AppState>,
    Json(req): Json<SaveRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let path = safe_path(&state.repo_root, &req.path).map_err(|_| (StatusCode::BAD_REQUEST, "Invalid path".into()))?;

    if path.exists() {
        let current_bytes = std::fs::read(&path).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let current_etag = generate_etag(&current_bytes);
        if current_etag != req.etag {
            return Ok(Json(serde_json::json!({
                "status": "conflict",
                "message": "File has changed on disk. Reload required."
            })));
        }
    }

    let tmp_path = path.with_extension("tmp_save");
    if let Err(e) = std::fs::write(&tmp_path, &req.content) {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
    }
    if let Err(e) = std::fs::rename(&tmp_path, &path) {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
    }
    let new_etag = generate_etag(req.content.as_bytes());
    Ok(Json(serde_json::json!({ "status": "ok", "new_etag": new_etag })))
}

async fn get_checklist(State(state): State<AppState>) -> Json<BTreeMap<String, ChecklistItem>> {
    let map = state.checklist.read().unwrap();
    Json(map.clone())
}

async fn patch_checklist(
    State(state): State<AppState>,
    Json(req): Json<PatchChecklist>,
) -> Json<serde_json::Value> {
    let mut map = state.checklist.write().unwrap();
    let item = map.entry(req.path.clone()).or_insert(ChecklistItem {
        status: "todo".into(), note: "".into(), updated_ts: now(),
    });
    if let Some(s) = req.status { item.status = s; }
    if let Some(n) = req.note { item.note = n; }
    item.updated_ts = now();

    let json = serde_json::to_string_pretty(&*map).unwrap_or_default();
    if let Some(parent) = state.checklist_path.parent() { let _ = std::fs::create_dir_all(parent); }
    let _ = std::fs::write(&state.checklist_path, json);
    Json(serde_json::json!({ "ok": true }))
}

// --- Main ---

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let args: Vec<String> = std::env::args().collect();
    
    // Use arg if provided, otherwise current dir
    let raw_path = if args.len() > 1 { PathBuf::from(&args[1]) } else { std::env::current_dir().unwrap() };
    
    let repo_root = std::fs::canonicalize(&raw_path).unwrap_or_else(|_| {
        eprintln!("Error: Directory '{:?}' not found.", raw_path);
        std::process::exit(1);
    });

    println!("Scanning repository at: {:?}", repo_root);

    let checklist_path = repo_root.join("codeedit/checklist.json");
    let checklist_map = if checklist_path.exists() {
        let data = std::fs::read(&checklist_path).unwrap_or_default();
        serde_json::from_slice(&data).unwrap_or_default()
    } else { BTreeMap::new() };

    let state = AppState {
        repo_root, checklist_path, checklist: Arc::new(RwLock::new(checklist_map)),
    };

    let app = Router::new()
        .route("/api/search", get(search))
        .route("/api/file", get(get_file).post(save_file))
        .route("/api/checklist", get(get_checklist).patch(patch_checklist))
        .nest_service("/", ServeDir::new("../web/dist")) 
        .layer(CorsLayer::permissive()) 
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    println!("Server running at http://{}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// --- TESTS ---
// Run with: cargo test
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use tempfile::TempDir; // Add 'tempfile = "3"' to Cargo.toml if needed, or just use standard temp logic

    // Helper to make a temp dir structure
    fn setup_env() -> (TempDir, PathBuf) {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().to_path_buf();
        
        // Create structure
        // root/
        //   src/
        //     main.rs (contains "fn main")
        //     util.rs (contains "pub fn help")
        //   README.md (contains "TODO list")
        //   target/
        //     ignore_me.rs (contains "fn main")
        
        fs::create_dir(root.join("src")).unwrap();
        fs::create_dir(root.join("target")).unwrap();

        let mut f = fs::File::create(root.join("src/main.rs")).unwrap();
        writeln!(f, "fn main() {{ println!(\"Hello\"); }}").unwrap();

        let mut f = fs::File::create(root.join("src/util.rs")).unwrap();
        writeln!(f, "pub fn help() {{ }}").unwrap();

        let mut f = fs::File::create(root.join("README.md")).unwrap();
        writeln!(f, "# My Project\nTODO: finish this.").unwrap();

        let mut f = fs::File::create(root.join("target/ignore_me.rs")).unwrap();
        writeln!(f, "fn main() {{ // duplicate }}").unwrap();

        (temp_dir, root)
    }

    #[test]
    fn test_search_content_substring() {
        let (_tmp, root) = setup_env();
        let results = perform_search(&root, "println", false, None);
        
        assert_eq!(results.len(), 1);
        assert!(results[0].file.contains("main.rs"));
        assert!(results[0].preview.contains("fn main"));
    }

    #[test]
    fn test_search_filename() {
        let (_tmp, root) = setup_env();
        let results = perform_search(&root, "util.rs", false, None);
        
        assert_eq!(results.len(), 1);
        assert!(results[0].file.contains("util.rs"));
        assert!(results[0].preview.contains("FILENAME MATCH"));
    }

    #[test]
    fn test_search_ignore_target() {
        let (_tmp, root) = setup_env();
        // "fn main" appears in src/main.rs AND target/ignore_me.rs
        // But perform_search should skip 'target'
        let results = perform_search(&root, "fn main", false, None);
        
        assert_eq!(results.len(), 1);
        assert!(results[0].file.contains("src")); // Ensure we got the src one, not target
    }
}