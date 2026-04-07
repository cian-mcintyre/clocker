'use strict';

const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const { execFile, spawn } = require('child_process');
const ffmpegPath  = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { v4: uuidv4 } = require('uuid');
const sharp       = require('sharp');

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

console.log('FFmpeg:   ', ffmpegPath);
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
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', chunk => {
      const str = chunk.toString();
      stderr += str;
      const m = str.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (m && onProgress) onProgress(m[1]);
    });
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (exit ${code}, signal ${signal}):\n${stderr.slice(-4000)}`));
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

    // Render text as a transparent 1920×1080 PNG using sharp + SVG.
    // This works on any platform with no system fonts required.
    const { name, number, client, duration } = details;
    const overlayPath = path.join(tmpDir, 'overlay.png');
    await renderTextOverlay({ name, number, client, duration }, overlayPath);

    // Inputs:
    //   [0] clock.mp4
    //   [1] main video
    //   [2] overlay.png  (looped as a still image)
    //   [3] (optional) silent audio for clock if no audio track
    //   [4] (optional) silent audio for main if no audio track
    const args = ['-y'];
    args.push('-i', CLOCK_PATH);
    args.push('-i', inputPath);
    args.push('-loop', '1', '-i', overlayPath);  // still PNG looped for duration of clock

    let clockAudioRef = '[0:a]';
    let mainAudioRef  = '[1:a]';
    let nextIdx       = 3;

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
      // Overlay the text PNG on clock.mp4 for the first 7 s only
      "[0:v][2:v]overlay=enable='lt(t,7)'[clockv]",
      '[clockv][mainvn]concat=n=2:v=1:a=0[outv]',
      `${clockAudioRef}${mainAudioRef}concat=n=2:v=0:a=1[outa]`,
    ].join(';');

    args.push(
      '-filter_complex', filterComplex,
      '-map', '[outv]', '-map', '[outa]',
      '-threads', '2',          // cap threads to reduce peak memory usage
      '-max_muxing_queue_size', '1024',
    );

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

// ── Text overlay ─────────────────────────────────────────────────────────
// Renders the 4 clock fields as white text on a transparent 1920×1080 PNG.
// Uses sharp + SVG so no system fonts or FFmpeg drawtext filter are needed.

async function renderTextOverlay(details, outputPath) {
  const W = 1920, H = 1080;
  const { name, number, client, duration } = details;

  const lines = [
    `Name: ${name || ''}`,
    `Number: ${number || ''}`,
    `Client: ${client || ''}`,
    `Duration: ${duration || ''}`,
  ];

  const x      = 150;
  const startY = 800;
  const lineH  = 52;
  const fontSize = 38;

  // Build SVG text elements — one per line
  const textEls = lines.map((line, i) => {
    const y = startY + i * lineH;
    // Escape XML special chars
    const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `
      <text
        x="${x}" y="${y}"
        font-family="Arial, Helvetica, sans-serif"
        font-size="${fontSize}"
        font-weight="600"
        fill="white"
        filter="url(#shadow)"
      >${escaped}</text>`;
  }).join('\n');

  const svg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
          <feDropShadow dx="2" dy="2" stdDeviation="3" flood-color="black" flood-opacity="0.75"/>
        </filter>
      </defs>
      ${textEls}
    </svg>`;

  await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: Buffer.from(svg), blend: 'over' }])
    .png()
    .toFile(outputPath);
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
