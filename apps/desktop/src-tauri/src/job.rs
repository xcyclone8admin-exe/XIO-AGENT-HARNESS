//! Kill-on-close Job Object: the OS ends every sidecar process when the shell's last handle to the
//! job closes, including when the shell is hard-killed (Task Manager, crash, `taskkill /F`). That
//! closes the orphan-sidecar gap without a boot-time reaper matching processes by path.

use std::process::Child;

#[cfg(windows)]
pub struct KillOnCloseJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

// SAFETY: a job handle is a kernel object handle; Win32 job APIs are thread-safe.
#[cfg(windows)]
unsafe impl Send for KillOnCloseJob {}
#[cfg(windows)]
unsafe impl Sync for KillOnCloseJob {}

#[cfg(windows)]
impl KillOnCloseJob {
    pub fn new() -> std::io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        // SAFETY: plain Win32 calls with owned, correctly sized arguments.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let job = Self { handle };
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }
    }

    pub fn assign(&self, child: &Child) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        // SAFETY: the child handle is valid while `child` is borrowed.
        let ok = unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle() as _) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    /// End every process in the job (the sidecar and anything it started).
    pub fn terminate_all(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        // SAFETY: valid job handle owned by self.
        unsafe {
            TerminateJobObject(self.handle, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        // SAFETY: we own the handle; closing it ends every process still in the job.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(not(windows))]
pub struct KillOnCloseJob;

#[cfg(not(windows))]
impl KillOnCloseJob {
    pub fn new() -> std::io::Result<Self> {
        Ok(Self)
    }
    pub fn assign(&self, _child: &Child) -> std::io::Result<()> {
        Ok(())
    }
    pub fn terminate_all(&self) {}
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{Duration, Instant};

    #[test]
    fn dropping_the_job_ends_its_processes() {
        let systemroot = std::env::var("SYSTEMROOT").unwrap_or_else(|_| r"C:\Windows".into());
        let ping = std::path::Path::new(&systemroot)
            .join("System32")
            .join("PING.EXE");
        let job = KillOnCloseJob::new().unwrap();
        let mut child = Command::new(ping)
            .args(["-n", "60", "127.0.0.1"])
            .spawn()
            .unwrap();
        job.assign(&child).unwrap();
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        panic!("closing the job did not end its process");
    }
}
