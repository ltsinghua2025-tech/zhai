#[path = "../src-tauri/citizen_knowledge_build.rs"]
mod citizen_knowledge_build;

fn main() {
    citizen_knowledge_build::prepare().expect("prepare citizen reply knowledge");
    tauri_build::build()
}
