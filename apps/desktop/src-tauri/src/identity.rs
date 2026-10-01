//! The trusted OS identity the shell hands the sidecar (`XYRA_OS_SUBJECT`). It comes from the
//! process token, never from the WebView or HTTP input.

/// `windows-sid:<SID>` of the user this shell runs as.
#[cfg(windows)]
pub fn os_subject() -> std::io::Result<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // SAFETY: Win32 calls on the current process token with buffers sized by the API.
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut needed = 0u32;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
        let mut buffer = vec![0u8; needed as usize];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        );
        CloseHandle(token);
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut wide: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut wide) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut len = 0;
        while *wide.add(len) != 0 {
            len += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(wide, len));
        LocalFree(wide.cast());
        Ok(format!("windows-sid:{sid}"))
    }
}

#[cfg(not(windows))]
pub fn os_subject() -> std::io::Result<String> {
    std::env::var("USER")
        .map(|u| format!("unix-user:{u}"))
        .map_err(|_| std::io::Error::other("no OS user"))
}

/// A display name for first-run identity; falls back to the account name.
pub fn display_name() -> String {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Authentication::Identity::{GetUserNameExW, NameDisplay};
        let mut buffer = [0u16; 256];
        let mut len = buffer.len() as u32;
        // SAFETY: buffer and length describe a valid writable region.
        if unsafe { GetUserNameExW(NameDisplay, buffer.as_mut_ptr(), &mut len) } && len > 0 {
            let name = String::from_utf16_lossy(&buffer[..len as usize]);
            if !name.trim().is_empty() {
                return name;
            }
        }
    }
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .ok()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "Local user".into())
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn subject_is_the_process_token_sid() {
        let subject = super::os_subject().unwrap();
        assert!(subject.starts_with("windows-sid:S-1-5-"), "{subject}");
        assert_eq!(subject, super::os_subject().unwrap(), "stable across calls");
    }

    #[test]
    fn display_name_is_never_empty() {
        assert!(!super::display_name().trim().is_empty());
    }
}
