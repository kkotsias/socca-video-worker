import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json());

app.post("/process", async (req, res) => {
  const logs = [];
  const log = (msg) => {
    console.log(msg);
    logs.push(msg);
  };

  try {
    const {
      input_video_url,
      match_id,
      upload_url
    } = req.body;

    log(`JOB START match_id=${match_id}`);
    log("Downloading video...");

    const inputPath = `/tmp/input-${match_id}.mp4`;
    const outputPath = `/tmp/output-${match_id}.mp4`;

    const r = await fetch(input_video_url);
    if (!r.ok) throw new Error("Failed to download input video");

    const file = fs.createWriteStream(inputPath);
    await new Promise(resolve => r.body.pipe(file).on("finish", resolve));

    log("Download complete");
    log("Running ffmpeg remux...");

    const run = (cmd) =>
      new Promise((resolve, reject) =>
        exec(cmd, (err) => err ? reject(err) : resolve())
      );

    try {
      await run(`ffmpeg -y -i ${inputPath} -c copy -movflags +faststart ${outputPath}`);
      log("Remux successful");
    } catch (err) {
      log("Remux failed, falling back to transcode");
      await run(
        `ffmpeg -y -i ${inputPath} -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags +faststart ${outputPath}`
      );
      log("Transcode successful");
    }

    log("Uploading processed video...");
    const uploadRes = await fetch(upload_url, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: fs.createReadStream(outputPath),
    });

    if (!uploadRes.ok) throw new Error("Upload failed");

    log("Upload complete");
    log("JOB SUCCESS");

    res.json({
      status: "success",
      match_id,
      stream_url: upload_url.split("?")[0],
      logs
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: "error",
      error: err.message,
      logs
    });
  }
});


app.listen(3000);
