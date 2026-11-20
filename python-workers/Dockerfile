ARG NODE_IMAGE=node:22-bookworm-slim
ARG PYTHON_IMAGE=python:3.13-slim-bookworm
FROM ${NODE_IMAGE} AS node
FROM ${PYTHON_IMAGE}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV PYTHONUNBUFFERED=1 PYTHONUTF8=1 \
    MINERU_MODEL_SOURCE=local MINERU_TELEMETRY_DISABLED=1 \
    LAWVERIFY_PYTHON=/usr/local/bin/python3 LAWVERIFY_MINERU_HOME=/models \
    LAWVERIFY_PARSER_ROOT=/data/parsing LAWVERIFY_PARSER_BUNDLED=1 PARSER_DEVICE=cpu PARSER_WORKERS=1
WORKDIR /opt/lawverify
ARG DEBIAN_MIRROR=https://deb.debian.org
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
    && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /tmp/requirements.txt
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r /tmp/requirements.txt
COPY *.mjs *.py python-workers.ts python-workers/
RUN useradd --create-home --uid 10001 parser && mkdir -p /data/parsing && chown -R parser:parser /data
USER parser
EXPOSE 8790
HEALTHCHECK --interval=15s --timeout=5s --start-period=300s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:8790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "python-workers/http-service.mjs"]
