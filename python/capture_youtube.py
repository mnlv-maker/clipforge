import os
import sys

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadCancelled

url, output_template, stop_file = sys.argv[1:4]


def stop_when_requested(status):
    if status.get("status") == "downloading" and os.path.exists(stop_file):
        raise DownloadCancelled("Captura detenida por el usuario")


options = {
    "format": "best[acodec!=none][vcodec!=none]/best",
    "outtmpl": output_template,
    "no_playlist": True,
    "no_warnings": False,
    "quiet": True,
    "no_progress": True,
    "nopart": True,
    "overwrites": True,
    "progress_hooks": [stop_when_requested],
}
try:
    with YoutubeDL(options) as downloader:
        downloader.download([url])
except DownloadCancelled as error:
    print(str(error), file=sys.stderr)
