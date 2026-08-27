FROM docker.io/cloudflare/sandbox:0.12.1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip \
    && python3 -m pip install --no-cache-dir "yt-dlp[default]" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Sandbox uses this port to communicate with the local Worker runtime.
EXPOSE 8080
