import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json());

app.post("/process", async (req, res) => {
  const { input_video_url, match_id, upload_url } = req.body;

  const inputPath = `/tmp/input-${match_id}.mp4`;
  const outputPath = `/tmp/output-${match_id}.mp4`;

  // download
  const r = await fetch(input_video_url);
  const file = fs.createWriteStream(inputPath);
  await new Promise(resolve => r.body.pipe(file).on("finish", resolve));

  // ffmpeg
  exec(
    `ffmpeg -y -i ${inputPath} -c copy -movflags +faststart ${outputPath}`,
    async (err) => {
      if (err) {
        return res.status(500).json({ error: "ffmpeg failed" });
      }

      // upload back (presigned URL)
      await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4" },
        body: fs.createReadStream(outputPath),
      });

      res.json({ success: true });
    }
  );
});

app.listen(3000);
