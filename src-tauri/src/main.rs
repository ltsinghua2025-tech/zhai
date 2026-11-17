// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) == Some("--mcp-stdio") {
        let result = args
            .get(2)
            .ok_or_else(|| "缺少本地工具端点".to_string())
            .and_then(|path| {
                material_workshop_desktop_lib::run_mcp_stdio(std::path::Path::new(path))
            });
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    material_workshop_desktop_lib::run()
}
