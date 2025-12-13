from fastapi import FastAPI
from pydantic import BaseModel
import os, tempfile, math
import requests
import numpy as np
import cv2

from sklearn.cluster import KMeans
import torch
from transformers import CLIPProcessor, CLIPModel

app = FastAPI()

class AnalyzeReq(BaseModel):
    match_id: str
    video_url: str
    supabase_url: str
    supabase_service_role_key: str
    max_patterns: int = 8

def supabase_insert(supabase_url: str, key: str, table: str, rows: list[dict]):
    url = f"{supabase_url.rstrip('/')}/rest/v1/{table}"
    r = requests.post(
        url,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
        json=rows,
        timeout=120,
    )
    r.raise_for_status()
    return r.json()

def supabase_patch(supabase_url: str, key: str, table: str, match_id: str, patch: dict):
    url = f"{supabase_url.rstrip('/')}/rest/v1/{table}?id=eq.{match_id}"
    r = requests.patch(
        url,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
        json=patch,
        timeout=60,
    )
    r.raise_for_status()
    return r.json()

def download_video(url: str, out_path: str):
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(out_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024*1024):
                if chunk:
                    f.write(chunk)

def sample_windows(video_path: str, window_sec: int = 8, stride_sec: int = 20):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError("Cannot open video")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    duration_sec = total_frames / fps if total_frames > 0 else 0

    windows = []
    t = 0.0
    while t + window_sec <= duration_sec:
        # take 3 frames inside each window
        frame_times = [t + 1.0, t + window_sec/2, t + window_sec - 1.0]
        frames = []
        for ft in frame_times:
            cap.set(cv2.CAP_PROP_POS_MSEC, ft * 1000)
            ok, frame = cap.read()
            if ok and frame is not None:
                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                frames.append(frame_rgb)
        if len(frames) >= 2:
            windows.append({
                "start_sec": float(t),
                "end_sec": float(t + window_sec),
                "frames": frames
            })
        t += stride_sec

    cap.release()
    return windows

def embed_windows_clip(windows):
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32").to(device)
    proc = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")

    embs = []
    for w in windows:
        inputs = proc(images=w["frames"], return_tensors="pt").to(device)
        with torch.no_grad():
            feats = model.get_image_features(**inputs)  # (n_frames, dim)
            feat = feats.mean(dim=0)  # average frames -> one embedding per window
            feat = feat / feat.norm(p=2)
        embs.append(feat.cpu().numpy())
    return np.vstack(embs)

def cluster_embeddings(embs: np.ndarray, k: int):
    km = KMeans(n_clusters=k, random_state=42, n_init="auto")
    labels = km.fit_predict(embs)
    return labels

@app.post("/analyze")
def analyze(req: AnalyzeReq):
    # Mark running (optional; Edge can do it too)
    supabase_patch(req.supabase_url, req.supabase_service_role_key, "matches", req.match_id, {
        "status": "running",
        "error_message": None
    })

    with tempfile.TemporaryDirectory() as td:
        video_path = os.path.join(td, "source.mp4")
        download_video(req.video_url, video_path)

        windows = sample_windows(video_path, window_sec=8, stride_sec=20)
        if len(windows) < 10:
            supabase_patch(req.supabase_url, req.supabase_service_role_key, "matches", req.match_id, {
                "status": "failed",
                "error_message": "Not enough windows sampled from video"
            })
            return {"status": "error", "error": "Not enough windows sampled"}

        embs = embed_windows_clip(windows)

        # Choose K based on volume (simple heuristic for V1)
        k = max(4, min(12, len(windows) // 8))
        labels = cluster_embeddings(embs, k=k)

        # Count frequency per cluster and pick top
        counts = {}
        for lab in labels:
            counts[int(lab)] = counts.get(int(lab), 0) + 1
        top_clusters = sorted(counts.items(), key=lambda x: x[1], reverse=True)[:req.max_patterns]

        # Insert patterns + examples
        patterns_rows = []
        for idx, (cl, cnt) in enumerate(top_clusters, start=1):
            patterns_rows.append({
                "match_id": req.match_id,
                "side": "unknown",
                "title": f"Repeated Pattern #{idx}",
                "summary": f"Cluster {cl} appears {cnt} times. (V1 auto-grouping)",
                "confidence": min(0.95, 0.5 + cnt / max(10, len(windows))),
            })

        inserted_patterns = supabase_insert(req.supabase_url, req.supabase_service_role_key, "patterns", patterns_rows)

        # Map cluster -> pattern_id
        cluster_to_pattern_id = {}
        for i, (cl, _) in enumerate(top_clusters):
            cluster_to_pattern_id[int(cl)] = inserted_patterns[i]["id"]

        examples_rows = []
        for w, lab in zip(windows, labels):
            lab = int(lab)
            if lab in cluster_to_pattern_id:
                examples_rows.append({
                    "pattern_id": cluster_to_pattern_id[lab],
                    "start_sec": w["start_sec"],
                    "end_sec": w["end_sec"],
                })

        if examples_rows:
            supabase_insert(req.supabase_url, req.supabase_service_role_key, "pattern_examples", examples_rows)

        # Update match summary
        supabase_patch(req.supabase_url, req.supabase_service_role_key, "matches", req.match_id, {
            "status": "done",
            "analysis_summary": f"Found {len(top_clusters)} repeated pattern clusters from sampled windows.",
        })

        return {"status": "success", "patterns": len(top_clusters), "examples": len(examples_rows)}
