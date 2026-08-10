FROM python:3.13.5-slim-bookworm

LABEL org.opencontainers.image.title="Puppetmaster Science runtime contract fixture" \
      org.opencontainers.image.version="0.2.0" \
      org.opencontainers.image.description="Deterministic HttpComputeProvider fixture; executes no user code"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SCIENCE_RUNTIME_HOST=0.0.0.0 \
    SCIENCE_RUNTIME_PORT=8090 \
    SCIENCE_RUNTIME_STATE_DIR=/var/lib/science-runtime

RUN groupadd --gid 10001 science \
 && useradd --uid 10001 --gid science --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin science \
 && mkdir -p /opt/science-runtime /var/lib/science-runtime/outputs \
 && chown -R science:science /var/lib/science-runtime \
 && chmod 0755 /opt/science-runtime

COPY --chown=root:root --chmod=0555 server.py /opt/science-runtime/server.py

WORKDIR /opt/science-runtime
USER 10001:10001
EXPOSE 8090
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD ["python", "-I", "-c", "import json,urllib.request; assert json.load(urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=2))['ok'] is True"]

ENTRYPOINT ["python", "-I", "/opt/science-runtime/server.py"]
