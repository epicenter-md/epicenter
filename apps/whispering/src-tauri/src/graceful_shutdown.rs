use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct SignalResult {
    success: bool,
    message: String,
}

/// Send a SIGINT signal to a process by PID.
/// This is equivalent to Ctrl+C and allows graceful shutdown.
#[tauri::command]
pub fn send_sigint(pid: u32) -> SignalResult {
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;

        let process_pid = Pid::from_raw(pid as i32);

        match kill(process_pid, Signal::SIGINT) {
            Ok(_) => SignalResult {
                success: true,
                message: format!("SIGINT sent to process {}", pid),
            },
            Err(err) => SignalResult {
                success: false,
                message: format!("Failed to send SIGINT to process {}: {}", pid, err),
            },
        }
    }

    #[cfg(windows)]
    {
        // Windows: Use Ctrl+C event for console processes
        use windows_sys::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_C_EVENT};

        unsafe {
            let result = GenerateConsoleCtrlEvent(CTRL_C_EVENT, pid);

            if result != 0 {
                SignalResult {
                    success: true,
                    message: format!("Ctrl+C event sent to process {}", pid),
                }
            } else {
                SignalResult {
                    success: false,
                    message: format!("Failed to send Ctrl+C to process {}", pid),
                }
            }
        }
    }
}
