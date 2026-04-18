FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
# docker-rootfs/ is the extracted contents of cave-linux-x64.tar.gz (binary + companions).
# cave resolves theme/, export-html/, photon_rs_bg.wasm via dirname(process.execPath),
# so the binary and companions must live together.
COPY docker-rootfs/ /opt/cave/
RUN chmod +x /opt/cave/cave && ln -s /opt/cave/cave /usr/local/bin/cave
WORKDIR /work
ENTRYPOINT ["cave"]
