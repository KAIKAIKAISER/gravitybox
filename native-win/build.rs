fn main() {
    #[cfg(target_os = "windows")]
    {
        let ico_path = std::path::Path::new("../assets/icons/app.ico");
        if ico_path.exists() {
            println!("cargo:rerun-if-changed=../assets/icons/app.ico");
            let mut res = winresource::WindowsResource::new();
            res.set_icon("../assets/icons/app.ico");
            res.set("ProductName", "GravityBox");
            res.set("FileDescription", "GravityBox Desktop Monitor");
            res.set("LegalCopyright", "GravityBox");
            let _ = res.compile();
        }
    }
}
