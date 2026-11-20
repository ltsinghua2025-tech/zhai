ARG BASE=python:3.12-slim@sha256:c61cffc3bacb94ed026ff8b45d5114b7693dd0420baca0a1ace0e3d0ce9035fd
FROM ${BASE} AS dependencies
ENV OPENSSL_armcap=0
COPY wheels/ /tmp/wheels/
COPY zhai/engine/requirements.txt /tmp/requirements.txt
RUN test "$(uname -m)" = aarch64 && python3 -c "import sys; assert sys.version_info[:2] == (3, 12)" \
    && python3 -m venv /app/zhai/.venv \
    && /app/zhai/.venv/bin/python3 -m pip install --no-index --no-cache-dir --find-links=/tmp/wheels -r /tmp/requirements.txt \
    && /app/zhai/.venv/bin/python3 -m pip check
FROM ${BASE}
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OPENSSL_armcap=0 \
    ZHAI_WEB_HOST=0.0.0.0 ZHAI_WEB_PORT=8080 ZHAI_JUDGE_MODE=1 ZHAI_WEB_REVISION=r1 \
    ZHAI_DATA_DIR=/app/zhai/data ZHAI_CONFIG_FILE=/run/zhai/private-config.json
COPY --from=dependencies /app/zhai/.venv /app/zhai/.venv
COPY zhai/ /app/zhai/
RUN command -v setpriv >/dev/null && python3 /app/zhai/verify-package.py && mkdir -p /run/zhai
COPY entrypoint.sh /app/entrypoint.sh
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=3).close()"
CMD ["bash", "/app/entrypoint.sh"]
