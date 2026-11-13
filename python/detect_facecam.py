import json
import math
import os
import statistics
import sys
import urllib.request
from pathlib import Path

import cv2
import mediapipe as mp


MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
)


def ensure_model(model_path: Path) -> None:
    if model_path.is_file() and model_path.stat().st_size > 100_000:
        return
    model_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = model_path.with_suffix(".download")
    try:
        urllib.request.urlretrieve(MODEL_URL, temporary)
        if temporary.stat().st_size < 100_000:
            raise RuntimeError("El modelo de detección descargado está incompleto.")
        os.replace(temporary, model_path)
    finally:
        temporary.unlink(missing_ok=True)


def clamp(value: float, maximum: float) -> float:
    return max(0.0, min(value, maximum))


def facecam_roi(
    box, frame_width: int, frame_height: int, camera_height: int
) -> dict[str, float]:
    center_x = (box["x"] + box["width"] / 2) / frame_width
    center_y = (box["y"] + box["height"] / 2) / frame_height
    face_width = box["width"] / frame_width
    face_height = box["height"] / frame_height
    target_ratio = 56.25 / camera_height * frame_height / frame_width
    height = min(0.48, max(face_height * 2.8, face_width * 1.8))
    width = min(0.72, height * target_ratio)
    height = min(0.55, width / target_ratio)
    x = clamp(center_x - width / 2, 1 - width)
    y = clamp(center_y - height * 0.42, 1 - height)
    return {"x": x, "y": y, "width": width, "height": height}


def smooth_rois(observations, frame_width: int, frame_height: int, camera_height: int):
    raw = [
        facecam_roi(item["box"], frame_width, frame_height, camera_height)
        for item in observations
    ]
    smoothed = []
    for index, item in enumerate(raw):
        nearby = raw[max(0, index - 1): min(len(raw), index + 2)]
        smoothed.append({
            "time": observations[index]["time"],
            **{
                key: statistics.median(roi[key] for roi in nearby)
                for key in ("x", "y", "width", "height")
            },
        })
    return smoothed


def detect(
    source: str, clip_start: float, clip_end: float, model_path: Path, camera_height: int
):
    ensure_model(model_path)
    video = cv2.VideoCapture(source)
    if not video.isOpened():
        raise RuntimeError("No se pudo abrir el video para analizar la cámara.")
    try:
        frame_width = int(video.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_height = int(video.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = video.get(cv2.CAP_PROP_FPS) or 30
        duration = max(0.0, clip_end - clip_start)
        # Sample across the complete clip so face-following can react to changes
        # of framing instead of tracking only an early moment.
        sample_count = min(24, max(10, math.ceil(duration / 2.5)))
        interval = duration / max(1, sample_count - 1)
        options = mp.tasks.vision.FaceDetectorOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
            min_detection_confidence=0.25,
        )
        observations = []
        with mp.tasks.vision.FaceDetector.create_from_options(options) as detector:
            for index in range(sample_count):
                timestamp = min(clip_start + index * interval, max(clip_start, clip_end - 0.01))
                video.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
                ok, frame = video.read()
                if not ok:
                    continue
                scale = min(1.0, 960 / frame.shape[1])
                if scale < 1:
                    frame = cv2.resize(
                        frame,
                        (int(frame.shape[1] * scale), int(frame.shape[0] * scale)),
                        interpolation=cv2.INTER_AREA,
                    )
                # Search the usual streamer-camera area first (lower right),
                # then the rest of the lower third. Coordinates are restored
                # to full-frame pixels before storing normalized ROIs.
                h, w = frame.shape[:2]
                regions = [
                    (int(w * .55), int(h * .55), w, h),
                    (0, int(h * .55), w, h),
                    (0, 0, w, h),
                ]
                found_in_sample = False
                for region_index, (x0, y0, x1, y1) in enumerate(regions):
                    if region_index == 2 and found_in_sample:
                        break
                    area_frame = frame[y0:y1, x0:x1]
                    rgb = cv2.cvtColor(area_frame, cv2.COLOR_BGR2RGB)
                    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                    result = detector.detect(image)
                    for detection in result.detections:
                        bbox = detection.bounding_box
                        width = max(0, bbox.width)
                        height = max(0, bbox.height)
                        area = width * height / (w * h)
                        if area < 0.001 or area > 0.32:
                            continue
                        score = float(detection.categories[0].score) if detection.categories else 0.0
                        bx, by = x0 + bbox.origin_x, y0 + bbox.origin_y
                        observations.append({
                            "sample": index,
                            "time": timestamp - clip_start,
                            "score": score,
                            "box": {"x": max(0, bx / scale), "y": max(0, by / scale),
                                    "width": width / scale, "height": height / scale},
                            "region": region_index,
                        })
                        found_in_sample = True
    finally:
        video.release()

    clusters = []
    for item in sorted(observations, key=lambda value: (value["sample"], -value["score"])):
        box = item["box"]
        cx = (box["x"] + box["width"] / 2) / frame_width
        cy = (box["y"] + box["height"] / 2) / frame_height
        matches = []
        for cluster in clusters:
            current_observation = cluster[-1]
            if item["sample"] - current_observation["sample"] not in (1, 2, 3):
                continue
            current = current_observation["box"]
            current_x = (current["x"] + current["width"] / 2) / frame_width
            current_y = (current["y"] + current["height"] / 2) / frame_height
            distance = math.hypot(cx - current_x, cy - current_y)
            width_ratio = box["width"] / max(current["width"], 1)
            if distance < 0.28 and 0.4 < width_ratio < 2.5:
                matches.append((distance, cluster))
        if not matches:
            clusters.append([item])
        else:
            min(matches, key=lambda item_match: item_match[0])[1].append(item)
    candidates = []
    minimum_observations = max(3, math.ceil(sample_count * 0.2))
    for cluster in clusters:
        unique_samples = {item["sample"] for item in cluster}
        if len(unique_samples) < minimum_observations:
            continue
        cluster.sort(key=lambda item: item["time"])
        rois = smooth_rois(cluster, frame_width, frame_height, camera_height)
        support = min(1.0, len(unique_samples) / sample_count)
        mean_score = statistics.mean(item["score"] for item in cluster)
        confidence = round(min(0.99, support * 0.7 + mean_score * 0.3), 3)
        segments = []
        for index, roi in enumerate(rois):
            left = 0.0 if index == 0 else (rois[index - 1]["time"] + roi["time"]) / 2
            right = duration if index == len(rois) - 1 else (roi["time"] + rois[index + 1]["time"]) / 2
            segments.append({key: value for key, value in roi.items() if key != "time"} | {
                "start": left,
                "end": right,
            })
        roi = {
            key: statistics.median(segment[key] for segment in segments)
            for key in ("x", "y", "width", "height")
        }
        candidates.append({
            "confidence": confidence,
            "observations": len(unique_samples),
            "roi": roi,
            "segments": segments,
        })
    # Prefer persistent detections in the lower half, with a tie-break toward
    # the lower right. This makes the default robust without hardcoding a crop.
    for candidate in candidates:
        roi = candidate["roi"]
        candidate["locationScore"] = round(max(0, roi["y"] + roi["height"] - .45) * .25 + roi["x"] * .08, 3)
    candidates.sort(key=lambda candidate: (
        candidate["observations"], candidate["confidence"] + candidate["locationScore"]
    ), reverse=True)
    return {
        "found": bool(candidates and candidates[0]["confidence"] >= 0.42),
        "frameWidth": frame_width,
        "frameHeight": frame_height,
        "sampleCount": sample_count,
        "analysisSeconds": round(duration, 2),
        "candidates": candidates[:4],
        "selected": candidates[0] if candidates and candidates[0]["confidence"] >= 0.42 else None,
    }


if __name__ == "__main__":
    try:
        result = detect(
            sys.argv[1],
            float(sys.argv[2]),
            float(sys.argv[3]),
            Path(sys.argv[4]),
            int(sys.argv[5]),
        )
        print(json.dumps(result, separators=(",", ":")))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
