import json, sys
from faster_whisper import WhisperModel
import ctranslate2

src, out, model_name = sys.argv[1:4]
has_cuda = ctranslate2.get_cuda_device_count() > 0
device = "cuda" if has_cuda else "cpu"
compute_type = "float16" if has_cuda else "int8"
model = WhisperModel(model_name, device=device, compute_type=compute_type)
segments, info = model.transcribe(
    src,
    word_timestamps=True,
    vad_filter=True,
    vad_parameters={"min_silence_duration_ms": 450, "speech_pad_ms": 180},
    beam_size=5,
    condition_on_previous_text=True,
)
words = []
for seg in segments:
    for w in seg.words or []:
        words.append({"w": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2)})
    if info.duration:
        print(f"P {min(seg.end / info.duration, 1):.3f}", flush=True)
with open(out, "w", encoding="utf-8") as f:
    json.dump({"language": info.language, "duration": info.duration, "words": words}, f, ensure_ascii=False)
