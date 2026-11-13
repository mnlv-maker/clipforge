"""Import YouTube and Kick sources with yt-dlp's best separate streams."""
import json
import os
import sys
from yt_dlp import YoutubeDL
from yt_dlp.utils import YoutubeDLError

OPTIONS = {
    "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
    "format_sort": ["res", "fps", "vcodec:h264", "acodec:aac"],
    "merge_output_format": "mp4", "noplaylist": True, "quiet": True,
    "no_warnings": True, "concurrent_fragment_downloads": 8,
    "impersonate": "chrome",
    "extractor_args": {"youtube": {"player_client": ["android"]}},
}

# Optional Netscape-format cookies exported by the user. Never inspect browser
# profiles automatically; authenticated access must be explicitly configured.
cookies_file = os.environ.get("YTDLP_COOKIES_FILE", "").strip()
if cookies_file:
    OPTIONS["cookiefile"] = os.path.abspath(os.path.expanduser(cookies_file))


def with_impersonation_fallback(options, action):
    """Use Chrome impersonation when curl_cffi supports it, then retry plainly."""
    try:
        with YoutubeDL(options) as ydl:
            return action(ydl)
    except YoutubeDLError as error:
        message = str(error).lower()
        if "impersonate target" not in message and "curl_cffi" not in message:
            raise
        fallback = dict(options)
        fallback.pop("impersonate", None)
        with YoutubeDL(fallback) as ydl:
            return action(ydl)


def main():
    action, url, *extra = sys.argv[1:]
    if action == "info":
        info = with_impersonation_fallback(
            {**OPTIONS, "skip_download": True},
            lambda ydl: ydl.extract_info(url, download=False),
        )
        print(json.dumps({"id": info.get("id", "source"), "title": info.get("title"),
            "live_status": info.get("live_status", "not_live"), "is_live": info.get("is_live", False),
            "formats": info.get("formats", [])}, separators=(",", ":")))
        return

    if action == "download":
        with_impersonation_fallback(
            {**OPTIONS, "outtmpl": extra[0], "overwrites": True},
            lambda ydl: ydl.download([url]),
        )
        return

    raise ValueError("Acción de YouTube no reconocida")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Keep diagnostics useful without dumping request headers or cookies.
        print(f"yt-dlp: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
