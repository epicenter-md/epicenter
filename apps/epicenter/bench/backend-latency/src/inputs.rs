//! Reading the two inputs a latency number is only meaningful against, and
//! fingerprinting them so two results cannot be compared by accident.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

/// FNV-1a over 64 bits. Not a cryptographic digest and not trying to be: its
/// whole job is to make "you compared two different models" or "you compared two
/// different clips" impossible to miss. Full content, not a sample, so a model
/// requantized under the same filename still reads as a different input.
pub struct Digest(u64);

impl Digest {
    pub fn new() -> Digest {
        Digest(0xcbf2_9ce4_8422_2325)
    }

    pub fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 = (self.0 ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3);
        }
    }

    pub fn hex(&self) -> String {
        format!("{:016x}", self.0)
    }
}

/// Digest a whole file in chunks. Runs once, outside every timed region.
pub fn digest_file(path: &Path) -> Result<(String, u64), String> {
    let file = File::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut digest = Digest::new();
    let mut buffer = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        digest.write(&buffer[..read]);
        total += read as u64;
    }
    Ok((digest.hex(), total))
}

/// One decoded clip, already in the exact shape `Session::run` takes.
pub struct Audio {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_s: f64,
    pub digest: String,
}

/// Load a WAV as mono 16 kHz `f32`, refusing anything that would need
/// conversion.
///
/// The app resamples arbitrary input through rubato before inference, and that is
/// right for a product. It is wrong here: a resampler in the path means every
/// posture comparison also compares whatever the resampler did, and a clip
/// silently stretched or downmixed is a different benchmark wearing the same
/// filename. So this refuses instead of converting, and says what to convert to.
pub fn load_wav(path: &Path) -> Result<Audio, String> {
    let reader = hound::WavReader::open(path)
        .map_err(|error| format!("open WAV {}: {error}", path.display()))?;
    let spec = reader.spec();

    if spec.channels != 1 || spec.sample_rate != 16_000 {
        return Err(format!(
            "{} is {} Hz, {} channel(s); this harness only accepts 16000 Hz mono \
             so no resampler sits inside the measurement. Convert first, e.g. \
             `ffmpeg -i in.wav -ac 1 -ar 16000 -c:a pcm_s16le out.wav`",
            path.display(),
            spec.sample_rate,
            spec.channels
        ));
    }

    let samples = read_samples(reader, &spec, path)?;
    if samples.is_empty() {
        return Err(format!("{} decoded to zero samples", path.display()));
    }

    // Digest the decoded PCM rather than the file: two containers holding the
    // same audio are the same benchmark input, and a header difference is not.
    let mut digest = Digest::new();
    for sample in &samples {
        digest.write(&sample.to_le_bytes());
    }

    Ok(Audio {
        duration_s: samples.len() as f64 / f64::from(spec.sample_rate),
        sample_rate: spec.sample_rate,
        channels: spec.channels,
        digest: digest.hex(),
        samples,
    })
}

fn read_samples(
    reader: hound::WavReader<BufReader<File>>,
    spec: &hound::WavSpec,
    path: &Path,
) -> Result<Vec<f32>, String> {
    let fail = |error: hound::Error| format!("decode {}: {error}", path.display());
    match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Float, 32) => reader
            .into_samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(fail),
        (hound::SampleFormat::Int, 16) => reader
            .into_samples::<i16>()
            .map(|sample| sample.map(|value| f32::from(value) / 32_768.0))
            .collect::<Result<Vec<_>, _>>()
            .map_err(fail),
        (format, bits) => Err(format!(
            "{} is {bits}-bit {format:?}; this harness accepts 16-bit int or \
             32-bit float PCM",
            path.display()
        )),
    }
}
