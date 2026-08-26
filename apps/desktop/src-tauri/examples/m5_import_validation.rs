use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use cybermuse_desktop_lib::song_store::{
    ImportInterruption, Song, SongStatus, get_song, import_song, inspect_import_candidate,
    list_songs,
};
use cybermuse_desktop_lib::storage::write_versioned_json;

fn main() {
    if let Err(error) = run() {
        eprintln!("M5 import validation failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut arguments = std::env::args_os().skip(1);
    let ffmpeg = arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "ffmpeg argument missing".to_owned())?;
    let ffprobe = arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "ffprobe argument missing".to_owned())?;
    let app_root = arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "app root argument missing".to_owned())?;
    if arguments.next().is_some() {
        return Err("unexpected argument".to_owned());
    }
    if !ffmpeg.is_file() || !ffprobe.is_file() {
        return Err("bundled FFmpeg tools missing".to_owned());
    }
    fs::create_dir_all(&app_root).map_err(|_| "app root create failed".to_owned())?;
    let external = app_root.join("外部 音频");
    fs::create_dir_all(&external).map_err(|_| "external fixture root failed".to_owned())?;

    let mut imported = Vec::new();
    for (index, extension) in ["mp3", "wav", "flac"].iter().enumerate() {
        let source = external.join(format!("格式 验证 {index}.{extension}"));
        generate_audio(&ffmpeg, &source)?;
        let token = format!("00000000-0000-4000-8000-{index:012}");
        let candidate =
            inspect_import_candidate(token, source.clone(), &ffmpeg, &ffprobe, &app_root)
                .map_err(|error| format!("{extension} preflight: {}", error.code))?;
        let result = import_song(
            &app_root,
            &candidate,
            SongStatus::NeedsAnalysis,
            ImportInterruption::Never,
        )
        .map_err(|error| format!("{extension} import: {}", error.code))?;
        if result.deduplicated || result.song.source_extension != *extension {
            return Err(format!("{extension} first import semantics invalid"));
        }
        if *extension == "flac" {
            let duplicate = import_song(
                &app_root,
                &candidate_with_token(&candidate, "00000000-0000-4000-8000-999999999999"),
                SongStatus::NeedsAnalysis,
                ImportInterruption::Never,
            )
            .map_err(|error| format!("duplicate import: {}", error.code))?;
            if !duplicate.deduplicated || duplicate.song.song_id != result.song.song_id {
                return Err("duplicate content was not reused".to_owned());
            }
        }
        fs::remove_file(&source).map_err(|_| "external source removal failed".to_owned())?;
        get_song(&app_root, &result.song.song_id)
            .map_err(|error| format!("copied asset unavailable: {}", error.code))?;
        imported.push(result.song.song_id);
    }

    let invalid = external.join("损坏 输入.wav");
    fs::write(&invalid, b"not an audio stream").map_err(|_| "invalid fixture failed".to_owned())?;
    let invalid_error = inspect_import_candidate(
        "00000000-0000-4000-8000-888888888888".to_owned(),
        invalid,
        &ffmpeg,
        &ffprobe,
        &app_root,
    )
    .expect_err("invalid audio must be rejected");
    if invalid_error.code != "AUDIO_UNSUPPORTED" {
        return Err(format!("invalid audio error was {}", invalid_error.code));
    }

    let disk_source = external.join("空间 验证.wav");
    generate_audio(&ffmpeg, &disk_source)?;
    let mut disk_candidate = inspect_import_candidate(
        "00000000-0000-4000-8000-777777777777".to_owned(),
        disk_source,
        &ffmpeg,
        &ffprobe,
        &app_root,
    )
    .map_err(|error| format!("disk candidate: {}", error.code))?;
    disk_candidate.required_free_bytes = u64::MAX;
    let disk_error = import_song(
        &app_root,
        &disk_candidate,
        SongStatus::NeedsAnalysis,
        ImportInterruption::Never,
    )
    .expect_err("disk budget must be rechecked");
    if disk_error.code != "DISK_SPACE_LOW" {
        return Err(format!("disk error was {}", disk_error.code));
    }

    let songs = list_songs(&app_root).map_err(|error| error.code.to_owned())?;
    if songs.len() != 3 || imported.len() != 3 {
        return Err("three-format Library result missing".to_owned());
    }
    for index in 3..1000_u64 {
        let id = format!("{index:064x}");
        let root = app_root.join("data").join("songs").join(&id);
        fs::create_dir_all(&root).map_err(|_| "virtual Library root failed".to_owned())?;
        fs::write(root.join("original.wav"), [0_u8])
            .map_err(|_| "virtual Library asset failed".to_owned())?;
        write_versioned_json(
            &root.join("song.json"),
            &Song {
                schema_version: 1,
                song_id: id,
                display_name: format!("Virtual Song {index:04}"),
                source_extension: "wav".to_owned(),
                original_relative_path: "original.wav".to_owned(),
                duration_ms: 1_000,
                imported_at: "2026-08-26T00:00:00Z".to_owned(),
                updated_at: "2026-08-26T00:00:00Z".to_owned(),
                status: SongStatus::NeedsAnalysis,
                active_analysis_id: None,
                last_practice_at: None,
            },
        )
        .map_err(|_| "virtual Library metadata failed".to_owned())?;
    }
    let library_start = Instant::now();
    let thousand = list_songs(&app_root).map_err(|error| error.code.to_owned())?;
    let library_duration_ms = library_start.elapsed().as_millis();
    if thousand.len() != 1000 || library_duration_ms > 5_000 {
        return Err(format!(
            "1000-song Library benchmark failed: count={}, durationMs={library_duration_ms}",
            thousand.len()
        ));
    }
    println!(
        "{}",
        serde_json::json!({
            "schemaVersion": 1,
            "testCases": ["TC-IMP-001", "TC-IMP-002", "TC-IMP-003", "TC-LIB-001"],
            "formats": ["mp3", "wav", "flac"],
            "songCount": songs.len(),
            "libraryMetadataCount": thousand.len(),
            "library1000DurationMs": library_duration_ms,
            "deduplicated": true,
            "externalSourceIndependent": true,
            "invalidAudioRejected": invalid_error.code,
            "diskBudgetRejected": disk_error.code,
            "unicodePath": true,
            "result": "pass"
        })
    );
    Ok(())
}

fn candidate_with_token(
    candidate: &cybermuse_desktop_lib::song_store::ImportCandidate,
    token: &str,
) -> cybermuse_desktop_lib::song_store::ImportCandidate {
    let mut candidate = candidate.clone();
    candidate.token = token.to_owned();
    candidate
}

fn generate_audio(ffmpeg: &Path, destination: &Path) -> Result<(), String> {
    let status = Command::new(ffmpeg)
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("sine=frequency=220:sample_rate=48000:duration=0.5")
        .arg("-ac")
        .arg("2")
        .arg("-y")
        .arg(destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "fixture FFmpeg start failed".to_owned())?;
    if status.success() {
        Ok(())
    } else {
        Err("fixture FFmpeg failed".to_owned())
    }
}
