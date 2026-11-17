use std::{env, fs, io, path::PathBuf};

const DOCUMENTS: [&str; 5] = [
    "template-index.md",
    "wording-rules.md",
    "satisfaction-appeal.md",
    "reply-templates-first-batch.md",
    "high-frequency-cases-second-batch.md",
];

pub fn prepare() -> io::Result<()> {
    const CUSTOM_DIR: &str = "ZHAI_CITIZEN_KNOWLEDGE_DIR";
    println!("cargo:rerun-if-env-changed={CUSTOM_DIR}");
    let shared_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src-tauri");
    let source = env::var_os(CUSTOM_DIR)
        .map(PathBuf::from)
        .unwrap_or_else(|| shared_dir.join("resources/citizen-knowledge"));
    let destination = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo build output directory"))
        .join("citizen-knowledge");
    fs::create_dir_all(&destination)?;
    for name in DOCUMENTS {
        let input = source.join(name);
        println!("cargo:rerun-if-changed={}", input.display());
        fs::write(destination.join(name), fs::read_to_string(input)?)?;
    }
    Ok(())
}
