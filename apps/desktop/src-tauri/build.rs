fn main() {
    println!("cargo:rerun-if-changed=../.output/public");
    tauri_build::build()
}
