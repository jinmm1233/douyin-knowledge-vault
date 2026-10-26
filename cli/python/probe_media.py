import argparse
import json
import os

import av


def probe_media(file_path: str) -> dict:
    with av.open(file_path, mode="r") as container:
        duration_seconds = 0.0
        if container.duration is not None:
            duration_seconds = float(container.duration / av.time_base)
        if duration_seconds <= 0:
            durations = [
                float(stream.duration * stream.time_base)
                for stream in container.streams
                if stream.duration is not None and stream.time_base is not None
            ]
            duration_seconds = max(durations, default=0.0)
        return {
            "durationSeconds": duration_seconds,
            "bytes": os.path.getsize(file_path),
            "hasAudio": any(stream.type == "audio" for stream in container.streams),
            "hasVideo": any(stream.type == "video" for stream in container.streams),
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("file", nargs="?")
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        print(json.dumps({"ok": True, "pyav": av.__version__}))
        return
    if not args.file:
        parser.error("file is required unless --self-check is used")
    print(json.dumps(probe_media(args.file), ensure_ascii=False))


if __name__ == "__main__":
    main()
