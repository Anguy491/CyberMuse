use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::analyzer_protocol::{
    MAX_PROTOCOL_LINE_BYTES, ProtocolError, ProtocolEvent, ProtocolValidator, Terminal,
};

const STDERR_LIMIT_BYTES: usize = 64 * 1024;
const CANCEL_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessError {
    pub code: &'static str,
    pub message_key: &'static str,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, String>,
    pub diagnostic_id: String,
}

impl ProcessError {
    fn new(reason: &'static str) -> Self {
        let mut safe_details = BTreeMap::new();
        safe_details.insert("reason".to_owned(), reason.to_owned());
        Self {
            code: "ANALYZER_PROTOCOL_ERROR",
            message_key: "analyzer.error.protocol",
            retryable: true,
            safe_details,
            diagnostic_id: format!("sidecar-{}", std::process::id()),
        }
    }

    fn start() -> Self {
        Self {
            code: "ANALYZER_STAGE_FAILED",
            message_key: "analyzer.error.startFailed",
            retryable: true,
            safe_details: BTreeMap::new(),
            diagnostic_id: format!("sidecar-{}", std::process::id()),
        }
    }
}

impl From<ProtocolError> for ProcessError {
    fn from(value: ProtocolError) -> Self {
        Self {
            code: value.code,
            message_key: value.message_key,
            retryable: value.retryable,
            safe_details: value.safe_details,
            diagnostic_id: value.diagnostic_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SidecarRunResult {
    pub terminal: Terminal,
    pub forced_termination: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug)]
struct CommandSpec {
    executable: PathBuf,
    arguments: Vec<String>,
    current_directory: PathBuf,
}

pub fn run_analyzer(
    executable: &Path,
    request_path: &Path,
    job_id: &str,
    cancel: Arc<AtomicBool>,
    on_event: impl FnMut(ProtocolEvent),
) -> Result<SidecarRunResult, ProcessError> {
    let executable = executable
        .canonicalize()
        .map_err(|_| ProcessError::start())?;
    let request_path = request_path
        .canonicalize()
        .map_err(|_| ProcessError::start())?;
    let current_directory = executable
        .parent()
        .ok_or_else(ProcessError::start)?
        .to_owned();
    run_command(
        CommandSpec {
            executable,
            arguments: vec![
                "analyze".to_owned(),
                "--request".to_owned(),
                request_path.to_string_lossy().into_owned(),
            ],
            current_directory,
        },
        job_id,
        cancel,
        CANCEL_GRACE,
        on_event,
    )
}

fn run_command(
    command: CommandSpec,
    job_id: &str,
    cancel: Arc<AtomicBool>,
    cancel_grace: Duration,
    mut on_event: impl FnMut(ProtocolEvent),
) -> Result<SidecarRunResult, ProcessError> {
    let mut process = Command::new(&command.executable);
    process
        .args(&command.arguments)
        .current_dir(&command.current_directory)
        .env_clear()
        .env(
            "PATH",
            command.executable.parent().unwrap_or(Path::new(".")),
        )
        .env(
            "SYSTEMROOT",
            std::env::var_os("SYSTEMROOT").unwrap_or_else(|| r"C:\Windows".into()),
        )
        .env(
            "WINDIR",
            std::env::var_os("WINDIR").unwrap_or_else(|| r"C:\Windows".into()),
        )
        .env("TEMP", std::env::temp_dir())
        .env("TMP", std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        process.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = process.spawn().map_err(|_| ProcessError::start())?;
    let stdout = child.stdout.take().ok_or_else(ProcessError::start)?;
    let stderr = child.stderr.take().ok_or_else(ProcessError::start)?;
    let mut stdin = child.stdin.take();
    let (line_sender, line_receiver) = mpsc::channel();
    let stdout_thread = thread::spawn(move || read_bounded_lines(stdout, line_sender));
    let stderr_thread = thread::spawn(move || drain_bounded(stderr, STDERR_LIMIT_BYTES));

    let mut validator = ProtocolValidator::new(job_id);
    let mut cancel_sent_at = None;
    let mut forced = false;
    let mut stdout_closed = false;
    let run_result = (|| {
        loop {
            drain_protocol_lines(
                &line_receiver,
                &mut stdout_closed,
                &mut validator,
                &mut on_event,
            )?;

            if cancel.load(Ordering::Acquire) && cancel_sent_at.is_none() {
                send_cancel(stdin.as_mut(), job_id)?;
                cancel_sent_at = Some(Instant::now());
            }
            if cancel_sent_at.is_some_and(|started| started.elapsed() >= cancel_grace) {
                child.kill().map_err(|_| ProcessError::new("kill_failed"))?;
                forced = true;
            }
            if let Some(status) = child
                .try_wait()
                .map_err(|_| ProcessError::new("wait_failed"))?
                && stdout_closed
            {
                break Ok(status);
            }
            thread::sleep(Duration::from_millis(10));
        }
    })();
    let exit_status = match run_result {
        Ok(status) => status,
        Err(error) => {
            let _ignored = child.kill();
            let _ignored = child.wait();
            let _ignored = stdout_thread.join();
            let _ignored = stderr_thread.join();
            return Err(error);
        }
    };

    stdout_thread
        .join()
        .map_err(|_| ProcessError::new("stdout_reader_failed"))?;
    drain_protocol_lines(
        &line_receiver,
        &mut stdout_closed,
        &mut validator,
        &mut on_event,
    )?;
    let (_, stderr_truncated) = stderr_thread
        .join()
        .map_err(|_| ProcessError::new("stderr_reader_failed"))?;
    if forced {
        return Ok(SidecarRunResult {
            terminal: Terminal::Cancelled,
            forced_termination: true,
            stderr_truncated,
        });
    }
    let exit_code = exit_status.code().unwrap_or(10);
    Ok(SidecarRunResult {
        terminal: validator.finish(exit_code)?,
        forced_termination: false,
        stderr_truncated,
    })
}

fn send_cancel(stdin: Option<&mut ChildStdin>, job_id: &str) -> Result<(), ProcessError> {
    let stdin = stdin.ok_or_else(|| ProcessError::new("stdin_closed"))?;
    let payload = serde_json::json!({
        "schemaVersion": 1,
        "type": "cancel",
        "jobId": job_id,
    });
    let mut bytes = serde_json::to_vec(&payload).map_err(|_| ProcessError::new("cancel_json"))?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .and_then(|()| stdin.flush())
        .map_err(|_| ProcessError::new("cancel_write"))
}

fn drain_protocol_lines(
    receiver: &Receiver<Result<Vec<u8>, ()>>,
    closed: &mut bool,
    validator: &mut ProtocolValidator,
    on_event: &mut impl FnMut(ProtocolEvent),
) -> Result<(), ProcessError> {
    loop {
        match receiver.try_recv() {
            Ok(Ok(line)) => on_event(validator.accept_line(&line)?),
            Ok(Err(())) => return Err(ProcessError::new("stdout_line_limit")),
            Err(TryRecvError::Empty) => return Ok(()),
            Err(TryRecvError::Disconnected) => {
                *closed = true;
                return Ok(());
            }
        }
    }
}

fn read_bounded_lines(mut reader: impl Read, sender: mpsc::Sender<Result<Vec<u8>, ()>>) {
    let mut buffer = [0_u8; 8192];
    let mut line = Vec::new();
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        for byte in &buffer[..count] {
            if *byte == b'\n' {
                if sender.send(Ok(std::mem::take(&mut line))).is_err() {
                    return;
                }
            } else {
                line.push(*byte);
                if line.len() > MAX_PROTOCOL_LINE_BYTES {
                    let _ignored = sender.send(Err(()));
                    return;
                }
            }
        }
    }
    if !line.is_empty() {
        let _ignored = sender.send(Ok(line));
    }
}

fn drain_bounded(mut reader: impl Read, limit: usize) -> (Vec<u8>, bool) {
    let mut output = Vec::with_capacity(limit.min(8192));
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        let remaining = limit.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..count.min(remaining)]);
        truncated |= count > remaining;
    }
    (output, truncated)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    const JOB: &str = "4ab0c16f-1234-4abc-8def-1234567890ab";

    fn powershell(script: String) -> CommandSpec {
        let executable =
            PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
        CommandSpec {
            current_directory: executable
                .parent()
                .expect("PowerShell should have a parent")
                .to_owned(),
            executable,
            arguments: vec![
                "-NoLogo".to_owned(),
                "-NoProfile".to_owned(),
                "-NonInteractive".to_owned(),
                "-Command".to_owned(),
                script,
            ],
        }
    }

    fn quoted(line: &str) -> String {
        format!("[Console]::Out.WriteLine('{}');", line.replace('\'', "''"))
    }

    fn success_script() -> String {
        let mut script = quoted(&format!(
            r#"{{"schemaVersion":1,"type":"hello","jobId":"{JOB}","protocolMajor":1,"analyzerVersion":"0.1.0"}}"#
        ));
        for (index, (stage, progress)) in [
            ("probe", 0.02),
            ("normalize", 0.1),
            ("separate", 0.65),
            ("pitch", 0.9),
            ("postprocess", 0.97),
            ("write", 1.0),
        ]
        .iter()
        .enumerate()
        {
            script.push_str(&quoted(&format!(
                r#"{{"schemaVersion":1,"type":"progress","jobId":"{JOB}","sequence":{},"stage":"{stage}","stageProgress":1.0,"progress":{progress}}}"#,
                index + 1
            )));
        }
        script.push_str(&quoted(&format!(
            r#"{{"schemaVersion":1,"type":"completed","jobId":"{JOB}","sequence":7,"manifestRelativePath":"analysis.json"}}"#
        )));
        script
    }

    #[test]
    fn tc_an_001_processes_fake_sidecar_without_shell_in_adapter() {
        let mut events = Vec::new();
        let result = run_command(
            powershell(success_script()),
            JOB,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(1),
            |event| events.push(event),
        )
        .expect("valid fake sidecar should pass");
        assert_eq!(result.terminal, Terminal::Completed);
        assert!(!result.forced_termination);
        assert_eq!(events.len(), 8);
    }

    #[test]
    fn tc_an_004_forces_analyzer_that_ignores_cancel() {
        let cancel = Arc::new(AtomicBool::new(true));
        let started = Instant::now();
        let result = run_command(
            powershell("$null=[Console]::In.ReadLine(); Start-Sleep -Seconds 30".to_owned()),
            JOB,
            cancel,
            Duration::from_millis(100),
            |_| {},
        )
        .expect("forced cancellation is a controlled result");
        assert_eq!(result.terminal, Terminal::Cancelled);
        assert!(result.forced_termination);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn tc_an_001_rejects_crash_and_bounds_stderr() {
        let crash = quoted(&format!(
            r#"{{"schemaVersion":1,"type":"hello","jobId":"{JOB}","protocolMajor":1,"analyzerVersion":"0.1.0"}}"#
        )) + "exit 10";
        assert!(
            run_command(
                powershell(crash),
                JOB,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(1),
                |_| {},
            )
            .is_err()
        );

        let script = success_script() + "[Console]::Error.Write(('x' * 100000));";
        let result = run_command(
            powershell(script),
            JOB,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(1),
            |_| {},
        )
        .expect("stderr must drain without deadlock");
        assert!(result.stderr_truncated);
    }
}
