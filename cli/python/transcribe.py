from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model", default="Systran/faster-whisper-small")
    parser.add_argument("--model-lock", required=True)
    parser.add_argument("--language", default="zh")
    parser.add_argument("--model-cache", required=True)
    parser.add_argument("--hf-endpoint", default="")
    return parser.parse_args()


def verify_model_files(model_dir: Path, lock: dict) -> None:
    for name, expected in lock.get("files", {}).items():
        file = model_dir / name
        if not file.is_file():
            raise FileNotFoundError(f"locked model file is missing: {name}")
        if file.stat().st_size != int(expected.get("bytes", -1)):
            raise RuntimeError(f"locked model file size mismatch: {name}")
        if sha256_file(file).lower() != str(expected.get("sha256", "")).lower():
            raise RuntimeError(f"locked model file hash mismatch: {name}")


def main() -> int:
    args = parse_args()
    source = Path(args.input).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"input does not exist: {source}")
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = Path(args.model_cache).resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    model_lock_file = Path(args.model_lock).resolve()
    model_lock = json.loads(model_lock_file.read_text(encoding="utf-8-sig"))
    repo_id = str(model_lock["repoId"])
    revision = str(model_lock["revision"])
    model_lock_sha256 = sha256_file(model_lock_file)
    transcript_file = output_dir / "transcript.json"
    manifest_file = output_dir / "transcription-manifest.json"
    input_sha256 = sha256_file(source)

    if transcript_file.is_file() and manifest_file.is_file():
        manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
        if (
            manifest.get("inputSha256") == input_sha256
            and manifest.get("model") == args.model
            and manifest.get("modelRevision") == revision
            and manifest.get("modelLockSha256") == model_lock_sha256
            and manifest.get("language") == args.language
        ):
            print(json.dumps({**manifest, "resumed": True}, ensure_ascii=False))
            return 0

    if args.hf_endpoint:
        os.environ["HF_ENDPOINT"] = args.hf_endpoint
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    from faster_whisper import WhisperModel
    from faster_whisper.utils import download_model

    configured_model = Path(args.model)
    if configured_model.is_dir():
        model_dir = configured_model.resolve()
    else:
        if args.model not in (repo_id, "small"):
            raise RuntimeError(f"configured model must match the lock: {repo_id}")
        model_dir = cache_dir / repo_id.replace("/", "--") / revision
        download_model(repo_id, output_dir=str(model_dir), revision=revision)
    verify_model_files(model_dir, model_lock)

    model = WhisperModel(
        str(model_dir),
        device="cpu",
        compute_type="int8",
    )
    segments_iter, info = model.transcribe(
        str(source),
        language=args.language,
        beam_size=5,
        vad_filter=True,
        word_timestamps=True,
        condition_on_previous_text=False,
    )
    segments: list[dict] = []
    words: list[dict] = []
    for segment in segments_iter:
        entry = {
            "start": round(segment.start, 3),
            "end": round(segment.end, 3),
            "text": segment.text.strip(),
            "words": [],
        }
        for word in segment.words or []:
            item = {
                "word": word.word,
                "start": round(word.start, 3),
                "end": round(word.end, 3),
                "probability": round(word.probability, 3),
            }
            entry["words"].append(item)
            words.append(item)
        segments.append(entry)
    transcript = {
        "segments": segments,
        "words": words,
        "text": "".join(segment["text"] for segment in segments),
        "language": info.language,
        "language_probability": round(info.language_probability, 4),
        "duration": round(info.duration, 3),
        "model": args.model,
        "modelRepoId": repo_id,
        "modelRevision": revision,
        "modelLockSha256": model_lock_sha256,
        "device": "cpu",
    }
    transcript_file.write_text(
        json.dumps(transcript, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    manifest = {
        "schemaVersion": 1,
        "inputSha256": input_sha256,
        "model": args.model,
        "modelRepoId": repo_id,
        "modelRevision": revision,
        "modelLockSha256": model_lock_sha256,
        "modelLabel": f"faster-whisper/{repo_id}@{revision}",
        "language": args.language,
        "detectedLanguage": transcript["language"],
        "durationSeconds": transcript["duration"],
        "segmentCount": len(segments),
        "wordCount": len(words),
        "transcriptSha256": sha256_file(transcript_file),
    }
    manifest_file.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({**manifest, "resumed": False}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
