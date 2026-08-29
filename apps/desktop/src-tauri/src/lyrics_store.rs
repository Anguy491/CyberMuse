use std::collections::{BTreeMap, btree_map::Entry};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::storage::{read_versioned_json, write_versioned_json};

const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_PHYSICAL_LINES: usize = 10_000;
const MAX_CUES: usize = 20_000;
const MAX_LINE_CHARS: usize = 1_000;
const MAX_OFFSET_MS: i64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum LyricsEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "utf-16be")]
    Utf16Be,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LyricsStatus {
    None,
    Ready,
    Damaged,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub author: Option<String>,
    pub creator: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsCue {
    pub timestamp_ms: u64,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsDocument {
    pub schema_version: u32,
    pub revision: u64,
    pub lyric_id: String,
    pub song_id: String,
    pub parser_version: String,
    pub imported_at: String,
    pub source_encoding: LyricsEncoding,
    pub source_sha256: String,
    pub source_text: String,
    pub source_offset_ms: i64,
    pub user_offset_ms: i64,
    pub metadata: LyricsMetadata,
    pub cues: Vec<LyricsCue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsView {
    pub schema_version: u32,
    pub revision: u64,
    pub lyric_id: String,
    pub song_id: String,
    pub source_encoding: LyricsEncoding,
    pub source_offset_ms: i64,
    pub user_offset_ms: i64,
    pub metadata: LyricsMetadata,
    pub cues: Vec<LyricsCue>,
}

impl From<&LyricsDocument> for LyricsView {
    fn from(value: &LyricsDocument) -> Self {
        Self {
            schema_version: value.schema_version,
            revision: value.revision,
            lyric_id: value.lyric_id.clone(),
            song_id: value.song_id.clone(),
            source_encoding: value.source_encoding,
            source_offset_ms: value.source_offset_ms,
            user_offset_ms: value.user_offset_ms,
            metadata: value.metadata.clone(),
            cues: value.cues.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsCandidatePreview {
    pub lyric_id: String,
    pub source_encoding: LyricsEncoding,
    pub metadata: LyricsMetadata,
    pub cue_group_count: usize,
    pub first_effective_time_ms: i64,
    pub last_effective_time_ms: i64,
    pub sample_lines: Vec<String>,
    pub warnings: Vec<String>,
    pub replacing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsError {
    pub code: &'static str,
    pub message_key: &'static str,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, String>,
    pub diagnostic_id: String,
}

impl LyricsError {
    fn new(code: &'static str, message_key: &'static str, retryable: bool) -> Self {
        Self {
            code,
            message_key,
            retryable,
            safe_details: BTreeMap::new(),
            diagnostic_id: format!("lyrics-store-{}", std::process::id()),
        }
    }

    fn invalid(reason: &'static str) -> Self {
        let mut error = Self::new("LYRICS_INVALID", "lyrics.error.invalid", false);
        error
            .safe_details
            .insert("reason".to_owned(), reason.to_owned());
        error
    }

    fn store(operation: &'static str) -> Self {
        let mut error = Self::new(
            "LYRICS_STORE_UNAVAILABLE",
            "lyrics.error.storeUnavailable",
            true,
        );
        error
            .safe_details
            .insert("operation".to_owned(), operation.to_owned());
        error
    }
}

fn lyrics_path(app_root: &Path, song_id: &str) -> PathBuf {
    app_root
        .join("data")
        .join("songs")
        .join(song_id)
        .join("lyrics")
        .join("lyrics.json")
}

fn decode_source(bytes: &[u8]) -> Result<(String, LyricsEncoding), LyricsError> {
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(LyricsError::new(
            "LYRICS_LIMIT_EXCEEDED",
            "lyrics.error.limitExceeded",
            false,
        ));
    }
    if let Some(value) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8(value.to_vec())
            .map(|text| (text, LyricsEncoding::Utf8))
            .map_err(|_| {
                LyricsError::new(
                    "LYRICS_ENCODING_UNSUPPORTED",
                    "lyrics.error.encodingUnsupported",
                    false,
                )
            });
    }
    if let Some(value) = bytes.strip_prefix(&[0xff, 0xfe]) {
        return String::from_utf16le(value)
            .map(|text| (text, LyricsEncoding::Utf16Le))
            .map_err(|_| {
                LyricsError::new(
                    "LYRICS_ENCODING_UNSUPPORTED",
                    "lyrics.error.encodingUnsupported",
                    false,
                )
            });
    }
    if let Some(value) = bytes.strip_prefix(&[0xfe, 0xff]) {
        return String::from_utf16be(value)
            .map(|text| (text, LyricsEncoding::Utf16Be))
            .map_err(|_| {
                LyricsError::new(
                    "LYRICS_ENCODING_UNSUPPORTED",
                    "lyrics.error.encodingUnsupported",
                    false,
                )
            });
    }
    String::from_utf8(bytes.to_vec())
        .map(|text| (text, LyricsEncoding::Utf8))
        .map_err(|_| {
            LyricsError::new(
                "LYRICS_ENCODING_UNSUPPORTED",
                "lyrics.error.encodingUnsupported",
                false,
            )
        })
}

fn timestamp_ms(value: &str) -> Option<u64> {
    let (minutes, seconds) = value.split_once(':')?;
    if minutes.is_empty() || minutes.len() > 3 || !minutes.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let (seconds, fraction) = match seconds.split_once('.') {
        Some((seconds, fraction)) => (seconds, Some(fraction)),
        None => (seconds, None),
    };
    if seconds.len() != 2 || !seconds.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let seconds = seconds.parse::<u64>().ok()?;
    if seconds >= 60 {
        return None;
    }
    let fraction_ms = match fraction {
        None => 0,
        Some(value)
            if !value.is_empty()
                && value.len() <= 3
                && value.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            let parsed = value.parse::<u64>().ok()?;
            parsed * 10_u64.pow(u32::try_from(3 - value.len()).ok()?)
        }
        Some(_) => return None,
    };
    minutes
        .parse::<u64>()
        .ok()?
        .checked_mul(60_000)?
        .checked_add(seconds * 1_000 + fraction_ms)
}

fn strip_enhanced_tags(value: &str) -> (String, bool) {
    let mut output = String::with_capacity(value.len());
    let chars = value.char_indices().collect::<Vec<_>>();
    let mut index = 0;
    let mut stripped = false;
    while index < chars.len() {
        let (byte_index, character) = chars[index];
        let closing = match character {
            '<' => '>',
            '[' => ']',
            _ => {
                output.push(character);
                index += 1;
                continue;
            }
        };
        let mut cursor = index + 1;
        while cursor < chars.len() && chars[cursor].1 != closing {
            cursor += 1;
        }
        if cursor < chars.len() {
            let end_byte = chars[cursor].0;
            let inner = &value[byte_index + character.len_utf8()..end_byte];
            if timestamp_ms(inner).is_some() {
                stripped = true;
                index = cursor + 1;
                continue;
            }
        }
        output.push(character);
        index += 1;
    }
    (output.trim().to_owned(), stripped)
}

fn push_warning(warnings: &mut Vec<String>, warning: &str) {
    if !warnings.iter().any(|current| current == warning) {
        warnings.push(warning.to_owned());
    }
}

pub fn parse_lrc(
    song_id: &str,
    duration_ms: u64,
    source_bytes: &[u8],
    replacing: bool,
) -> Result<(LyricsDocument, LyricsCandidatePreview), LyricsError> {
    if !song_id.bytes().all(|byte| byte.is_ascii_hexdigit()) || song_id.len() != 64 {
        return Err(LyricsError::invalid("song_id"));
    }
    let (decoded, source_encoding) = decode_source(source_bytes)?;
    let source_text = decoded.replace("\r\n", "\n").replace('\r', "\n");
    let physical_lines = source_text.split('\n').count();
    if physical_lines > MAX_PHYSICAL_LINES {
        return Err(LyricsError::new(
            "LYRICS_LIMIT_EXCEEDED",
            "lyrics.error.limitExceeded",
            false,
        ));
    }

    let mut grouped = BTreeMap::<u64, Vec<String>>::new();
    let mut metadata = LyricsMetadata::default();
    let mut source_offset_ms = None::<i64>;
    let mut warnings = Vec::new();
    for raw_line in source_text.split('\n') {
        if raw_line.chars().count() > MAX_LINE_CHARS {
            return Err(LyricsError::new(
                "LYRICS_LIMIT_EXCEEDED",
                "lyrics.error.limitExceeded",
                false,
            ));
        }
        let mut rest = raw_line.trim();
        if rest.is_empty() {
            continue;
        }
        let mut timestamps = Vec::new();
        while let Some(after_open) = rest.strip_prefix('[') {
            let Some(close) = after_open.find(']') else {
                break;
            };
            let tag = &after_open[..close];
            let after = &after_open[close + 1..];
            if let Some(timestamp) = timestamp_ms(tag) {
                timestamps.push(timestamp);
                rest = after;
                continue;
            }
            if timestamps.is_empty()
                && let Some((key, value)) = tag.split_once(':')
            {
                let key = key.trim().to_ascii_lowercase();
                let value = value.trim();
                if value.chars().count() > MAX_LINE_CHARS {
                    return Err(LyricsError::new(
                        "LYRICS_LIMIT_EXCEEDED",
                        "lyrics.error.limitExceeded",
                        false,
                    ));
                }
                match key.as_str() {
                    "ti" => metadata.title = Some(value.to_owned()),
                    "ar" => metadata.artist = Some(value.to_owned()),
                    "al" => metadata.album = Some(value.to_owned()),
                    "au" => metadata.author = Some(value.to_owned()),
                    "by" => metadata.creator = Some(value.to_owned()),
                    "offset" => {
                        let parsed = value
                            .parse::<i64>()
                            .map_err(|_| LyricsError::invalid("offset"))?;
                        if parsed.abs() > MAX_OFFSET_MS
                            || source_offset_ms.is_some_and(|current| current != parsed)
                        {
                            return Err(LyricsError::invalid("offset"));
                        }
                        source_offset_ms = Some(parsed);
                    }
                    _ => push_warning(&mut warnings, "LYRICS_METADATA_IGNORED"),
                }
                rest = after;
            }
            break;
        }
        if timestamps.is_empty() {
            if !rest.trim().is_empty() && !raw_line.trim_start().starts_with('[') {
                push_warning(&mut warnings, "LYRICS_UNTIMED_LINE_IGNORED");
            }
            continue;
        }
        let (text, enhanced) = strip_enhanced_tags(rest);
        if enhanced {
            push_warning(&mut warnings, "LYRICS_WORD_TIMING_IGNORED");
        }
        for timestamp in timestamps {
            match grouped.entry(timestamp) {
                Entry::Vacant(entry) => {
                    entry.insert(if text.is_empty() {
                        Vec::new()
                    } else {
                        vec![text.clone()]
                    });
                }
                Entry::Occupied(mut entry) => {
                    if !text.is_empty() && !entry.get().contains(&text) {
                        if entry.get().len() >= 32 {
                            return Err(LyricsError::new(
                                "LYRICS_LIMIT_EXCEEDED",
                                "lyrics.error.limitExceeded",
                                false,
                            ));
                        }
                        entry.get_mut().push(text.clone());
                    }
                }
            }
            if grouped.len() > MAX_CUES {
                return Err(LyricsError::new(
                    "LYRICS_LIMIT_EXCEEDED",
                    "lyrics.error.limitExceeded",
                    false,
                ));
            }
        }
    }

    if grouped.is_empty() || !grouped.values().any(|lines| !lines.is_empty()) {
        return Err(LyricsError::invalid("no_timed_lyrics"));
    }
    let source_offset_ms = source_offset_ms.unwrap_or(0);
    let overlaps = grouped.keys().any(|timestamp| {
        i64::try_from(*timestamp)
            .ok()
            .and_then(|time| time.checked_add(source_offset_ms))
            .is_some_and(|time| time <= i64::try_from(duration_ms).unwrap_or(i64::MAX))
    });
    if !overlaps {
        return Err(LyricsError::new(
            "LYRICS_MISMATCH",
            "lyrics.error.mismatch",
            false,
        ));
    }

    let cues = grouped
        .into_iter()
        .map(|(timestamp_ms, lines)| LyricsCue {
            timestamp_ms,
            lines,
        })
        .collect::<Vec<_>>();
    let lyric_id = hex_digest(Sha256::digest(source_bytes));
    let imported_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned());
    let document = LyricsDocument {
        schema_version: 1,
        revision: 0,
        lyric_id: lyric_id.clone(),
        song_id: song_id.to_owned(),
        parser_version: "lrc-line-v1".to_owned(),
        imported_at,
        source_encoding,
        source_sha256: lyric_id.clone(),
        source_text,
        source_offset_ms,
        user_offset_ms: 0,
        metadata: metadata.clone(),
        cues,
    };
    validate_document(&document, Some(song_id))?;
    let sample_lines = document
        .cues
        .iter()
        .flat_map(|cue| cue.lines.iter())
        .take(3)
        .cloned()
        .collect();
    let first = document.cues.first().expect("validated cues").timestamp_ms;
    let last = document.cues.last().expect("validated cues").timestamp_ms;
    let preview = LyricsCandidatePreview {
        lyric_id,
        source_encoding,
        metadata,
        cue_group_count: document.cues.len(),
        first_effective_time_ms: i64::try_from(first).unwrap_or(i64::MAX) + source_offset_ms,
        last_effective_time_ms: i64::try_from(last).unwrap_or(i64::MAX) + source_offset_ms,
        sample_lines,
        warnings,
        replacing,
    };
    Ok((document, preview))
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    let mut output = String::with_capacity(bytes.as_ref().len() * 2);
    for byte in bytes.as_ref() {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

fn validate_document(document: &LyricsDocument, song_id: Option<&str>) -> Result<(), LyricsError> {
    if document.schema_version != 1
        || document.parser_version != "lrc-line-v1"
        || document.lyric_id != document.source_sha256
        || document.lyric_id.len() != 64
        || song_id.is_some_and(|expected| document.song_id != expected)
        || document.source_offset_ms.abs() > MAX_OFFSET_MS
        || document.user_offset_ms.abs() > MAX_OFFSET_MS
        || document.source_text.len() > MAX_SOURCE_BYTES * 2
        || document.cues.is_empty()
        || document.cues.len() > MAX_CUES
        || document
            .cues
            .windows(2)
            .any(|pair| pair[0].timestamp_ms >= pair[1].timestamp_ms)
        || document.cues.iter().any(|cue| {
            cue.lines.len() > 32
                || cue
                    .lines
                    .iter()
                    .any(|line| line.chars().count() > MAX_LINE_CHARS)
        })
    {
        return Err(LyricsError::invalid("document"));
    }
    Ok(())
}

pub fn lyrics_status(app_root: &Path, song_id: &str) -> LyricsStatus {
    let path = lyrics_path(app_root, song_id);
    if !path.exists() {
        return LyricsStatus::None;
    }
    read_document(app_root, song_id)
        .map(|_| LyricsStatus::Ready)
        .unwrap_or(LyricsStatus::Damaged)
}

pub fn read_document(app_root: &Path, song_id: &str) -> Result<LyricsDocument, LyricsError> {
    let path = lyrics_path(app_root, song_id);
    let document: LyricsDocument = read_versioned_json(&path)
        .map_err(|_| LyricsError::new("LYRICS_DAMAGED", "lyrics.error.damaged", true))?;
    validate_document(&document, Some(song_id))?;
    Ok(document)
}

pub fn commit_document(
    app_root: &Path,
    document: &LyricsDocument,
) -> Result<(LyricsView, bool, bool), LyricsError> {
    let current = read_document(app_root, &document.song_id).ok();
    if let Some(current) = current
        .as_ref()
        .filter(|current| current.lyric_id == document.lyric_id)
    {
        return Ok((LyricsView::from(current), true, false));
    }
    let path = lyrics_path(app_root, &document.song_id);
    fs::create_dir_all(path.parent().expect("lyrics path parent"))
        .map_err(|_| LyricsError::store("create"))?;
    write_versioned_json(&path, document).map_err(|_| LyricsError::store("write"))?;
    Ok((LyricsView::from(document), false, current.is_some()))
}

pub fn update_offset(
    app_root: &Path,
    song_id: &str,
    lyric_id: &str,
    user_offset_ms: i64,
    expected_revision: u64,
) -> Result<LyricsView, LyricsError> {
    if user_offset_ms.abs() > MAX_OFFSET_MS {
        return Err(LyricsError::invalid("user_offset"));
    }
    let mut document = read_document(app_root, song_id)?;
    if document.lyric_id != lyric_id || document.revision != expected_revision {
        return Err(LyricsError::new(
            "LYRICS_CONFLICT",
            "lyrics.error.conflict",
            true,
        ));
    }
    document.user_offset_ms = user_offset_ms;
    document.revision = document
        .revision
        .checked_add(1)
        .ok_or_else(|| LyricsError::invalid("revision"))?;
    write_versioned_json(&lyrics_path(app_root, song_id), &document)
        .map_err(|_| LyricsError::store("offset"))?;
    Ok(LyricsView::from(&document))
}

pub fn remove_document(app_root: &Path, song_id: &str) -> Result<(), LyricsError> {
    let path = lyrics_path(app_root, song_id);
    if !path.exists() {
        return Err(LyricsError::new(
            "LYRICS_NOT_FOUND",
            "lyrics.error.notFound",
            false,
        ));
    }
    let removing = path.with_extension("json.removing");
    fs::rename(&path, &removing).map_err(|_| LyricsError::store("remove_stage"))?;
    if fs::remove_file(&removing).is_err() {
        let _ignored = fs::rename(&removing, &path);
        return Err(LyricsError::new(
            "LYRICS_DELETE_PARTIAL",
            "lyrics.error.deletePartial",
            true,
        ));
    }
    if let Some(parent) = path.parent() {
        let _ignored = fs::remove_dir(parent);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn root(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("cybermuse-lyrics-{name}-{stamp}"))
    }

    #[test]
    fn tc_lyr_001_parses_groups_offsets_and_enhanced_tags() {
        let input = b"[ti:Synthetic Song]\r\n[offset:+100]\r\n[00:15.44]First cue\r\n[00:20.40]\r\n[00:20.68]<00:20.68>Second cue\r\n[00:20.68]translation";
        let (document, preview) =
            parse_lrc(&"a".repeat(64), 240_000, input, false).expect("parse lrc");
        assert_eq!(document.source_offset_ms, 100);
        assert_eq!(document.cues.len(), 3);
        assert_eq!(document.cues[2].lines.len(), 2);
        assert!(
            preview
                .warnings
                .contains(&"LYRICS_WORD_TIMING_IGNORED".to_owned())
        );
        assert_eq!(preview.first_effective_time_ms, 15_540);
    }

    #[test]
    fn tc_lyr_001_decodes_utf16_and_rejects_invalid_files() {
        let text = "[00:01.25]\u{6b4c}\u{8bcd}";
        let mut bytes = vec![0xff, 0xfe];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let (document, _) = parse_lrc(&"b".repeat(64), 10_000, &bytes, false).expect("utf16 lrc");
        assert_eq!(document.source_encoding, LyricsEncoding::Utf16Le);
        assert!(parse_lrc(&"b".repeat(64), 10_000, b"plain text", false).is_err());
        assert!(parse_lrc(&"b".repeat(64), 10_000, &[0xff, 0xfe, 0x00], false).is_err());
    }

    #[test]
    fn tc_lyr_002_persists_updates_and_removes_atomically() {
        let app_root = root("store");
        let song_id = "c".repeat(64);
        let (document, _) = parse_lrc(&song_id, 10_000, b"[00:01.00]line", false).expect("parse");
        let (view, deduplicated, replaced) = commit_document(&app_root, &document).expect("commit");
        assert!(!deduplicated && !replaced);
        let updated = update_offset(&app_root, &song_id, &view.lyric_id, 250, 0).expect("offset");
        assert_eq!(updated.revision, 1);
        assert_eq!(updated.user_offset_ms, 250);
        assert_eq!(lyrics_status(&app_root, &song_id), LyricsStatus::Ready);
        remove_document(&app_root, &song_id).expect("remove");
        assert_eq!(lyrics_status(&app_root, &song_id), LyricsStatus::None);
        let _ignored = fs::remove_dir_all(app_root);
    }

    #[test]
    #[ignore = "requires CYBERMUSE_TEST_LRC_PATH"]
    fn tc_lyr_004_parses_user_supplied_moth_to_a_flame_lrc() {
        let source_path = std::env::var_os("CYBERMUSE_TEST_LRC_PATH")
            .map(PathBuf::from)
            .expect("CYBERMUSE_TEST_LRC_PATH");
        let source = fs::read(source_path).expect("read user-supplied LRC");
        let (document, preview) =
            parse_lrc(&"d".repeat(64), 234_021, &source, false).expect("parse user-supplied LRC");
        assert!(document.cues.len() >= 40);
        assert_eq!(preview.first_effective_time_ms, 15_440);
        assert!(preview.last_effective_time_ms <= 234_021);
    }
}
