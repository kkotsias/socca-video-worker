import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import fsp from "fs/promises";
import { exec } from "child_process";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
// Optional: set WORKER_SECRET in Fly env for auth (recommended)
const WORKER_SECRET = process.env.WORKER_SECRET || "";

// ---------- Health endpoints ----------
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// ---------- Helpers ----------
function makeLogger(jobId) {
  const logs = [];
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] [job:${jobId}] ${msg}`;
    console.log(line);
    logs.push(line);
  };
  return { logs, log };
}

function requireAuth(req) {
  if (!WORKER_SECRET) return;
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${WORKER_SECRET}`) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

function runCmd(cmd, log) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (stdout) log(`cmd stdout: ${stdout.slice(0, 4000)}`);
      if (stderr) log(`cmd stderr: ${stderr.slice(0, 8000)}`);
      if (err) return reject(err);
      resolve();
    });
  });
}

async function downloadToFile(url, filePath, log) {
  log(`Downloading input: ${url}`);
  const r = await fetch(url);
  if (!r.ok || !r.body) {
    throw new Error(`Download failed HTTP ${r.status}`);
  }

  const file = fs.createWriteStream(filePath);
  await new Promise((resolve, reject) => {
    r.body.pipe(file);
    r.body.on("error", reject);
    file.on("error", reject);
    file.on("finish", resolve);
  });

  const stat = await fsp.stat(filePath);
  log(`Download complete (${(stat.size / (1024 * 1024)).toFixed(1)} MB)`);
}

async function uploadToSupabaseStorage({
  supabase_url,
  supabase_key,
  storage_bucket,
  object_path,
  filePath,
  log,
}) {
  const base = supabase_url.replace(/\/+$/, "");
  const bucket = encodeURIComponent(storage_bucket);
  // IMPORTANT: for Storage API object endpoint, do NOT encode slashes in path,
  // but do encode each segment safely. We'll keep it simple:
  const safePath = object_path.split("/").map(encodeURIComponent).join("/");
  const url = `${base}/storage/v1/object/${bucket}/${safePath}`;

  log(`Uploading to Supabase Storage: bucket=${storage_bucket} path=${object_path}`);

  const stream = fs.createReadStream(filePath);
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabase_key}`,
      apikey: supabase_key,
      "Content-Type": "video/mp4",
      "x-upsert": "true",
    },
    body: stream,
  });

  const text = await r.text().catch(() => "");
  if (!r.ok) {
    throw new Error(`Supabase upload failed HTTP ${r.status}: ${text.slice(0, 300)}`);
  }

  // Public URL (ONLY works if bucket is public)
  const publicUrl = `${base}/storage/v1/object/public/${bucket}/${safePath}`;
  log(`Upload complete. public stream_url=${publicUrl}`);
  return publicUrl;
}

// ---------- Main endpoint ----------
app.post("/process", async (req, res) => {
  const jobId = crypto.randomUUID();
  const { logs, log } = makeLogger(jobId);

  let inputPath = "";
  let outputPath = "";

  try {
    requireAuth(req);

    const {
      input_video_url,
      match_id,
      storage_bucket,
      supabase_url,
      supabase_key,
    } = req.body || {};

    // Validate required fields
    if (!input_video_url || !match_id || !storage_bucket || !supabase_url || !supabase_key) {
      return res.status(400).json({
        status: "error",
        error:
          "Missing required fields. Need: input_video_url, match_id, storage_bucket, supabase_url, supabase_key",
        logs,
      });
    }

    log(`JOB START match_id=${match_id}`);
    log(`Bucket=${storage_bucket}`);

    // temp files
    inputPath = `/tmp/input-${match_id}`;
    outputPath = `/tmp/stream-${match_id}.mp4`;

    // 1) Download
    await downloadToFile(input_video_url, inputPath, log);

    // 2) Safe transcode (works across formats/codecs + Safari)
    log("Running ffmpeg TRANSCODE (safe mode: H.264 + AAC + faststart)...");
    const ffmpegCmd =
      `ffmpeg -y -i "${inputPath}" ` +
      `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ` +
      `-c:a aac -b:a 128k ` +
      `-movflags +faststart "${outputPath}"`;

    await runCmd(ffmpegCmd, log);
    log("ffmpeg transcode successful ✅");

    // 3) Upload to Supabase Storage
    const objectPath = `processed/${match_id}/stream.mp4`;
    const stream_url = await uploadToSupabaseStorage({
      supabase_url,
      supabase_key,
      storage_bucket,
      object_path: objectPath,
      filePath: outputPath,
      log,
    });

    log("JOB SUCCESS ✅");

    return res.json({
      status: "success",
      job_id: jobId,
      match_id,
      stream_url,
      logs,
    });
  } catch (err) {
    const statusCode = err?.statusCode || 500;
    const msg = err?.message || "Unknown error";
    log(`ERROR: ${msg}`);

    return res.status(statusCode).json({
      status: "error",
      job_id: jobId,
      error: msg,
      logs,
    });
  } finally {
    // cleanup
    try { if (inputPath) fs.unlinkSync(inputPath); } catch {}
    try { if (outputPath) fs.unlinkSync(outputPath); } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`socca ffmpeg worker running on port ${PORT}`);
});
