'use strict';

const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const { execFile } = require('child_process');
const ffmpegPath  = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

// Use /tmp on hosted platforms (ephemeral but always writable)
const TMP_ROOT = process.env.STORAGE_PATH || require('os').tmpdir();
const DIRS = {
  uploads: path.join(TMP_ROOT, 'clocker-uploads'),
  output:  path.join(TMP_ROOT, 'clocker-output'),
  tmp:     path.join(TMP_ROOT, 'clocker-tmp'),
};
Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));

// clock.mp4 lives in the project root alongside server.js
const CLOCK_PATH = path.join(__dirname, 'clock.mp4');

// Detect a usable font for FFmpeg drawtext — bundled font is checked first
// so it works on Railway (Linux) and locally (macOS) without any system fonts.
const FONT_PATHS = [
  path.join(__dirname, 'fonts', 'font.ttf'),                          // bundled — always works
  '/System/Library/Fonts/Helvetica.ttc',                              // macOS
  '/System/Library/Fonts/Supplemental/Arial.ttf',                     // macOS
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',                  // Debian/Ubuntu
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',  // Debian/Ubuntu
];
const FONT_FILE = FONT_PATHS.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;

console.log('FFmpeg:   ', ffmpegPath);
console.log('Font:     ', FONT_FILE || '(FFmpeg default)');
console.log('Clock:    ', fs.existsSync(CLOCK_PATH) ? CLOCK_PATH : 'NOT FOUND — add clock.mp4 to project root');

// In-memory job store
const jobs = new Map();

// Multer — up to 10 GB
const storage = multer.diskStorage({
  destination: DIRS.uploads,
  filename:    (_req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Utilities ─────────────────────────────────────────────────────────────

function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`ffprobe failed: ${err.message}`));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error('Failed to parse ffprobe output')); }
      }
    );
  });
}

function runFFmpeg(args, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = execFile(ffmpegPath, args, { maxBuffer: 100 * 1024 * 1024 });
    let stderr = '';
    proc.stderr.on('data', chunk => {
      const str = chunk.toString();
      stderr += str;
      const m = str.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (m && onProgress) onProgress(m[1]);
    });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (exit ${code}):\n${stderr.slice(-3000)}`));
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────

app.post('/process', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { name, number, client, duration, preset } = req.body;
  const jobId          = uuidv4();
  const inputPath      = req.file.path;
  const ext            = preset === 'mxf' ? '.mxf' : '.mov';
  const outputFilename = `clocked_${Date.now()}${ext}`;
  const outputPath     = path.join(DIRS.output, outputFilename);

  jobs.set(jobId, { status: 'processing', progress: null, outputFilename: null, error: null, inputPath, createdAt: Date.now() });

  res.json({ jobId });

  processVideo(inputPath, { name, number, client, duration }, preset, outputPath, jobId)
    .then(() => {
      const job = jobs.get(jobId);
      job.status = 'done';
      job.outputFilename = outputFilename;
    })
    .catch(err => {
      console.error(`Job ${jobId} failed:`, err.message);
      const job = jobs.get(jobId);
      job.status = 'error';
      job.error  = err.message;
    })
    .finally(() => { try { fs.unlinkSync(inputPath); } catch {} });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, progress: job.progress, outputFilename: job.outputFilename, error: job.error });
});

app.get('/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(DIRS.output, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath, filename);
});

// ── Video Processing ──────────────────────────────────────────────────────

async function processVideo(inputPath, details, preset, outputPath, jobId) {
  const job    = jobs.get(jobId);
  const tmpDir = path.join(DIRS.tmp, jobId);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    if (!fs.existsSync(CLOCK_PATH)) {
      throw new Error('clock.mp4 not found in project root.');
    }

    const [clockInfo, mainInfo] = await Promise.all([
      probeVideo(CLOCK_PATH),
      probeVideo(inputPath),
    ]);

    const clockHasAudio = clockInfo.streams.some(s => s.codec_type === 'audio');
    const mainHasAudio  = mainInfo.streams.some(s => s.codec_type === 'audio');
    const mainDuration  = parseFloat(mainInfo.format.duration) || 0;

    // Write text fields to individual files — avoids all FFmpeg filter escaping issues
    const { name, number, client, duration } = details;
    const fields = [
      { label: 'Name',     value: name     || '', file: path.join(tmpDir, 'f1.txt') },
      { label: 'Number',   value: number   || '', file: path.join(tmpDir, 'f2.txt') },
      { label: 'Client',   value: client   || '', file: path.join(tmpDir, 'f3.txt') },
      { label: 'Duration', value: duration || '', file: path.join(tmpDir, 'f4.txt') },
    ];
    for (const f of fields) fs.writeFileSync(f.file, `${f.label}: ${f.value}`);

    const TEXT_X    = 150;
    const TEXT_Y0   = 780;
    const LINE_H    = 50;
    const FONT_SIZE = 36;

    const fontArg  = FONT_FILE ? `fontfile='${FONT_FILE}'` : null;
    const baseStyle = [
      fontArg,
      'fontcolor=white',
      'shadowx=2:shadowy=2:shadowcolor=black@0.65',
      `fontsize=${FONT_SIZE}`,
      `x=${TEXT_X}`,
      `enable='lt(t,7)'`,
    ].filter(Boolean).join(':');

    const drawFilters = fields
      .map((f, i) => `drawtext=${baseStyle}:y=${TEXT_Y0 + i * LINE_H}:textfile='${f.file}'`)
      .join(',');

    // Inputs:
    //   [0] clock.mp4
    //   [1] main video
    //   [2] (optional) silent audio for clock if no audio track
    //   [3] (optional) silent audio for main if no audio track
    const args = ['-y'];
    args.push('-i', CLOCK_PATH);
    args.push('-i', inputPath);

    let clockAudioRef = '[0:a]';
    let mainAudioRef  = '[1:a]';
    let nextIdx       = 2;

    if (!clockHasAudio) {
      args.push('-f', 'lavfi', '-t', '10', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      clockAudioRef = `[${nextIdx}:a]`;
      nextIdx++;
    }
    if (!mainHasAudio) {
      args.push('-f', 'lavfi', '-t', String(mainDuration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      mainAudioRef = `[${nextIdx}:a]`;
    }

    const normalise = '[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,' +
                      'pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=25,setsar=1[mainvn]';

    const filterComplex = [
      normalise,
      `[0:v]${drawFilters}[clockv]`,
      `[clockv][mainvn]concat=n=2:v=1:a=0[outv]`,
      `${clockAudioRef}${mainAudioRef}concat=n=2:v=0:a=1[outa]`,
    ].join(';');

    args.push('-filter_complex', filterComplex, '-map', '[outv]', '-map', '[outa]');

    if (preset === 'prores') {
      args.push('-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le',
                '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2');
    } else {
      args.push('-c:v', 'dnxhd', '-b:v', '185M', '-pix_fmt', 'yuv422p',
                '-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2', '-f', 'mxf');
    }

    args.push(outputPath);

    await runFFmpeg(args, progress => { job.progress = progress; });

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Cleanup output files older than 2 hours ───────────────────────────────

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [jobId, job] of jobs) {
    if (job.createdAt < cutoff) {
      if (job.outputFilename) {
        try { fs.unlinkSync(path.join(DIRS.output, job.outputFilename)); } catch {}
      }
      jobs.delete(jobId);
    }
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log(`\nClocker → http://localhost:${PORT}\n`));
