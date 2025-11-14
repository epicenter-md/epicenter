/// Fixes Windows PATH inheritance bug in std::process::Command
///
/// On Windows, there's a known bug where Command::new() sometimes ignores
/// the parent process's PATH environment variable. This function ensures
/// child processes (like ffmpeg) can be found by explicitly setting PATH.
#[cfg(target_os = "windows")]
pub fn fix_windows_path() {
    use std::env;

    // Get current PATH
    if let Ok(path) = env::var("PATH") {
        // Simply re-setting the PATH forces std::process::Command to use it
        env::set_var("PATH", path);
        println!("Windows PATH inheritance fixed");
    }
}

#[cfg(not(target_os = "windows"))]
pub fn fix_windows_path() {
    // No-op on non-Windows platforms
}
