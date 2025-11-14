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
        // Windows: Use TerminateProcess for forceful shutdown
        // Note: GenerateConsoleCtrlEvent doesn't work with CREATE_NO_WINDOW processes
        // since they're not attached to a console session. TerminateProcess is more
        // reliable for processes spawned without a console.
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        use windows_sys::Win32::Foundation::CloseHandle;

        unsafe {
            let process_handle = OpenProcess(PROCESS_TERMINATE, 0, pid);

            if process_handle.is_null() {
                return SignalResult {
                    success: false,
                    message: format!("Failed to open process {}", pid),
                };
            }

            let result = TerminateProcess(process_handle, 1);
            CloseHandle(process_handle);

            if result != 0 {
                SignalResult {
                    success: true,
                    message: format!("Process {} terminated", pid),
                }
            } else {
                SignalResult {
                    success: false,
                    message: format!("Failed to terminate process {}", pid),
                }
            }
        }
    }
}