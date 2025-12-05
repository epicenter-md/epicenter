use std::fs::File;
use std::io::{self, BufWriter, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::time::Instant;
use log::{debug, info};

/// WAV file writer that supports progressive writing with header updates
pub struct WavWriter {
    writer: BufWriter<File>,
    sample_rate: u32,
    channels: u16,
    #[allow(dead_code)]
    bits_per_sample: u16,
    bytes_per_sample: u16,
    data_chunk_size_pos: u64,
    riff_chunk_size_pos: u64,
    samples_written: u64,
    last_header_update: Instant,
    file_path: PathBuf,
}

impl WavWriter {
    /// Create a new WAV file and write initial headers
    pub fn new(file_path: PathBuf, sample_rate: u32, channels: u16) -> io::Result<Self> {
        let file = File::create(&file_path)?;
        let mut writer = BufWriter::new(file);

        // We'll use 32-bit float format for consistency with the current implementation
        let bits_per_sample = 32;
        let bytes_per_sample = bits_per_sample / 8;

        // Write initial WAV header with placeholder sizes
        // We'll update these as we write samples

        // RIFF header
        writer.write_all(b"RIFF")?;
        let riff_chunk_size_pos = writer.stream_position()?;
        writer.write_all(&[0xFF, 0xFF, 0xFF, 0xFF])?; // Placeholder for file size - 8
        writer.write_all(b"WAVE")?;

        // fmt chunk
        writer.write_all(b"fmt ")?;
        writer.write_all(&16u32.to_le_bytes())?; // Subchunk1Size (16 for PCM)
        writer.write_all(&3u16.to_le_bytes())?; // AudioFormat (3 for IEEE Float)
        writer.write_all(&channels.to_le_bytes())?;
        writer.write_all(&sample_rate.to_le_bytes())?;
        let byte_rate = sample_rate * channels as u32 * bytes_per_sample as u32;
        writer.write_all(&byte_rate.to_le_bytes())?;
        let block_align = channels * bytes_per_sample;
        writer.write_all(&block_align.to_le_bytes())?;
        writer.write_all(&bits_per_sample.to_le_bytes())?;

        // data chunk
        writer.write_all(b"data")?;
        let data_chunk_size_pos = writer.stream_position()?;
        writer.write_all(&[0xFF, 0xFF, 0xFF, 0xFF])?; // Placeholder for data size

        writer.flush()?;

        info!(
            "Created WAV file at {:?}: {}Hz, {} channels, {}-bit float",
            file_path, sample_rate, channels, bits_per_sample
        );

        Ok(Self {
            writer,
            sample_rate,
            channels,
            bits_per_sample,
            bytes_per_sample,
            data_chunk_size_pos,
            riff_chunk_size_pos,
            samples_written: 0,
            last_header_update: Instant::now(),
            file_path,
        })
    }

    /// Write f32 samples to the WAV file
    pub fn write_samples_f32(&mut self, samples: &[f32]) -> io::Result<()> {
        // Write samples as little-endian f32
        for sample in samples {
            self.writer.write_all(&sample.to_le_bytes())?;
        }

        self.samples_written += samples.len() as u64;

        // Update headers periodically (every second)
        if self.last_header_update.elapsed().as_secs() >= 1 {
            self.update_headers()?;
            self.last_header_update = Instant::now();
        }

        Ok(())
    }

    /// Write i16 samples to the WAV file (converting to f32)
    pub fn write_samples_i16(&mut self, samples: &[i16]) -> io::Result<()> {
        // Convert i16 to f32 and write
        for &sample in samples {
            let f32_sample = sample as f32 / i16::MAX as f32;
            self.writer.write_all(&f32_sample.to_le_bytes())?;
        }

        self.samples_written += samples.len() as u64;

        // Update headers periodically
        if self.last_header_update.elapsed().as_secs() >= 1 {
            self.update_headers()?;
            self.last_header_update = Instant::now();
        }

        Ok(())
    }

    /// Write u16 samples to the WAV file (converting to f32)
    pub fn write_samples_u16(&mut self, samples: &[u16]) -> io::Result<()> {
        // Convert u16 to f32 and write
        for &sample in samples {
            let f32_sample = (sample as f32 / u16::MAX as f32) * 2.0 - 1.0;
            self.writer.write_all(&f32_sample.to_le_bytes())?;
        }

        self.samples_written += samples.len() as u64;

        // Update headers periodically
        if self.last_header_update.elapsed().as_secs() >= 1 {
            self.update_headers()?;
            self.last_header_update = Instant::now();
        }

        Ok(())
    }

    /// Update the WAV header size fields
    fn update_headers(&mut self) -> io::Result<()> {
        let current_pos = self.writer.stream_position()?;

        // Calculate sizes
        let data_size = self.samples_written * self.bytes_per_sample as u64;
        let file_size = 36 + data_size; // 36 = header size minus RIFF header

        // Update RIFF chunk size
        self.writer
            .seek(SeekFrom::Start(self.riff_chunk_size_pos))?;
        self.writer.write_all(&(file_size as u32).to_le_bytes())?;

        // Update data chunk size
        self.writer
            .seek(SeekFrom::Start(self.data_chunk_size_pos))?;
        self.writer.write_all(&(data_size as u32).to_le_bytes())?;

        // Seek back to end and flush
        self.writer.seek(SeekFrom::Start(current_pos))?;
        self.writer.flush()?;

        debug!(
            "Updated WAV headers: {} samples written ({:.2} seconds)",
            self.samples_written,
            self.get_duration_seconds()
        );

        Ok(())
    }

    /// Finalize the WAV file with correct headers
    pub fn finalize(&mut self) -> io::Result<()> {
        self.update_headers()?;
        self.writer.flush()?;

        info!(
            "Finalized WAV file {:?}: {} samples, {:.2} seconds",
            self.file_path,
            self.samples_written,
            self.get_duration_seconds()
        );

        Ok(())
    }

    /// Get the current duration in seconds
    pub fn get_duration_seconds(&self) -> f32 {
        self.samples_written as f32 / (self.sample_rate as f32 * self.channels as f32)
    }

    /// Get the file path
    pub fn get_file_path(&self) -> &PathBuf {
        &self.file_path
    }

    /// Get audio metadata
    pub fn get_metadata(&self) -> (u32, u16, f32) {
        (self.sample_rate, self.channels, self.get_duration_seconds())
    }

    /// Flush any buffered data to disk
    pub fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

impl Drop for WavWriter {
    fn drop(&mut self) {
        // Ensure headers are updated when the writer is dropped
        if let Err(e) = self.finalize() {
            // Log error but don't panic in drop
            log::error!("Failed to finalize WAV file on drop: {}", e);
        }
    }
}
