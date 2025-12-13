import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";
import fsp from "fs/promises";

const app = express();
app.use(express.json());

app.get("/", (_, res) => res.send("OK"));

app.post("/process", async (req, res) => {
  const logs = [];
  const log = (msg) => {
    console.log(msg);
    logs.push(msg);
  };

  const run = (cmd) =>
    new Promise((resolve, reject) => {
      exec(cmd, (err, stdout, stderr) => {
        if (stdout) log(`ffmpeg stdout: ${stdout.slice(0, 2000)}`);
        if (stderr) log(`ffmpeg stderr: ${stderr.slice(0, 2000)}`);
        if (err) return reject(err);
        resolve();
      });
    });

  let inputPath = "";
  let outputPath = "";

  try {
    const { input_video_url, match_id, upload_url } = req.body;

    if (!input_video_url || !match_id || !upload_url) {
      return res.status(400).json({
        status: "error",
        error: "Missing required fields",
        logs
      });
    }

    log(`JOB START match_id=${match_id}`);

    inputPath = `/tmp/input-${match_id}`;
    outputPath = `/tmp/output-${match_id}.mp4`;

    log("Downloading video...");
    const r = await fetch(input_video_url);
    if (!r.ok) throw new Error(`Download failed: ${r.status}`);

    const file = fs.createWriteStream(inputPath);
    await new Promise((resolve, reject) => {
      r.body.pipe(file);
      r.body.on("error", reject);
      file.on("finish", resolve);
    });

    const stat = await fsp.stat(inputPath);
    log(`Download complete, size=${stat.size}`);

    log("Running ffmpeg TRANSCODE (safe mode)...");
    await run(
      `ffmpeg -y -i ${inputPath} ` +
      `-c:v libx264 -preset veryfast -crf 23 ` +
      `-pix_fmt yuv420p ` +
      `-c:a aac -b:a 128k ` +
      `-movflags +faststart ${outputPath}`
    );

    log("Transcode successful");

    log("Uploading processed video...");
    const uploadRes = await fetch(upload_url, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: fs.createReadStream(outputPath),
    });

    if (!uploadRes.ok) {
      throw new Error(`Upload failed: ${uploadRes.status}`);
    }

    log("Upload complete");
    log("JOB SUCCESS");

    res.json({
      status: "success",
      match_id,
      stream_url: upload_url.split("?")[0],
      logs
    });

  } catch (err) {
    log(`ERROR: ${err.message}`);
    res.status(500).json({
      status: "error",
      error: err.message,
      logs
    });
  } finally {
    if (inputPath) fs.unlink(inputPath, () => {});
    if (outputPath) fs.unlink(outputPath, () => {});
  }
});

app.listen(3000, () => {
  console.log("ffmpeg worker listening on port 3000");
});
