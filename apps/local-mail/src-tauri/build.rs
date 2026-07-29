fn main() {
    println!("cargo:rerun-if-env-changed=LOCAL_MAIL_DISTRIBUTION_GMAIL_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=LOCAL_MAIL_DISTRIBUTION_GMAIL_CLIENT_SECRET");
    tauri_build::build()
}
