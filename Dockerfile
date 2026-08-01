#
# Copyright © 2022 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
#

# ---------------------------------------------------------------------------
# Stage 1: fetch external binaries (go-ios, bundletool)
# ---------------------------------------------------------------------------
FROM ubuntu:24.04 AS fetch

ARG GO_IOS_VERSION=1.2.0
ARG BUNDLETOOL_VERSION=1.2.0

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates wget unzip && \
    rm -rf /var/lib/apt/lists/*

# go-ios utility to manage iOS devices connected to a Linux provider host
RUN mkdir -p /out/bin && \
    wget --progress=dot:mega -O /tmp/go-ios-linux.zip \
      "https://github.com/danielpaulus/go-ios/releases/download/v${GO_IOS_VERSION}/go-ios-linux.zip" && \
    unzip /tmp/go-ios-linux.zip -d /out/bin && \
    chmod +x /out/bin/* && \
    rm /tmp/go-ios-linux.zip

RUN mkdir -p /out/bundletool && \
    wget --progress=dot:mega -O /out/bundletool/bundletool.jar \
      "https://github.com/google/bundletool/releases/download/${BUNDLETOOL_VERSION}/bundletool-all-${BUNDLETOOL_VERSION}.jar"

# ---------------------------------------------------------------------------
# Stage 2: build the app
# ---------------------------------------------------------------------------
FROM ubuntu:24.04 AS builder

ARG NODE_VERSION=17.9.0

ENV DEBIAN_FRONTEND=noninteractive \
    SETUPTOOLS_USE_DISTUTILS=local

# Toolchain + native module headers.
# Ubuntu 24.04 ships Python 3.12, which dropped distutils; node-gyp's bundled
# gyp still imports it, so setuptools provides the shim.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates wget git python3 python3-setuptools build-essential cmake yasm \
      libzmq3-dev libprotobuf-dev graphicsmagick && \
    rm -rf /var/lib/apt/lists/*

RUN useradd --system --create-home --shell /usr/sbin/nologin stf-build

# Node.js runtime (shared with the final stage via /usr/local).
RUN cd /tmp && \
    wget --progress=dot:mega \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" && \
    tar -xJf node-v*.tar.xz --strip-components 1 -C /usr/local && \
    rm node-v*.tar.xz && \
    su stf-build -s /bin/bash -c '/usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js install'

# Copy app source.
COPY --chown=stf-build:stf-build . /tmp/build/

RUN mkdir -p /opt && chown -R stf-build:stf-build /opt

USER stf-build

# Run the build.
RUN set -x && \
    cd /tmp/build && \
    export PATH=$PWD/node_modules/.bin:$PATH && \
    npm install --python="/usr/bin/python3" --loglevel http && \
    npm pack && \
    tar xzf devicefarmer-stf-*.tgz --strip-components 1 -C /opt && \
    bower cache clean && \
    npm prune --production && \
    mv node_modules /opt && \
    rm -rf ~/.node-gyp ~/.npm ~/.cache

# Device icon overrides.
RUN set -x && \
    cd /tmp/build && \
    cp ./icon/x120/iOS.jpg     /opt/node_modules/@devicefarmer/stf-device-db/dist/icon/x120/iOS && \
    cp ./icon/x24/iOS.jpg      /opt/node_modules/@devicefarmer/stf-device-db/dist/icon/x24/iOS && \
    cp ./icon/x120/Android.jpg /opt/node_modules/@devicefarmer/stf-device-db/dist/icon/x120/Android && \
    cp ./icon/x24/Android.jpg  /opt/node_modules/@devicefarmer/stf-device-db/dist/icon/x24/Android && \
    cp ./icon/x24/tvOS.png     /opt/node_modules/@devicefarmer/stf-device-db/dist/icon/x24/tvOS && \
    cp ./icon/x120/tvOS.png    /opt/node_modules/@devicefarmer/stf-device-db/dist/icon/x120/tvOS

# #951 bump up Pixel 7 on Android 14
COPY --chown=stf-build:stf-build files/STFService.apk /opt/vendor/STFService/STFService.apk

# ---------------------------------------------------------------------------
# Stage 3: runtime
# ---------------------------------------------------------------------------
FROM ubuntu:24.04

LABEL org.opencontainers.image.title="STF" \
      org.opencontainers.image.description="Smartphone Test Farm" \
      org.opencontainers.image.source="https://github.com/Dinip/stf"

ENV DEBIAN_FRONTEND=noninteractive \
    DEVICE_UDID= \
    PATH=/opt/bin:$PATH

# Runtime dependencies only - no compilers, headers or SDKs.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      graphicsmagick \
      iputils-ping \
      jq \
      libimobiledevice-utils \
      libimobiledevice6 \
      libplist-utils \
      libprotobuf32t64 \
      libzmq5 \
      openjdk-8-jre-headless \
      socat \
      unzip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*

RUN useradd --system --create-home --shell /usr/sbin/nologin stf && \
    mkdir -p /opt/data /data && \
    chown -R stf:stf /opt /data && \
    ln -s /opt /app

# Node.js runtime, built app and external tools.
COPY --from=builder /usr/local /usr/local
COPY --from=builder --chown=stf:stf /opt /opt
COPY --from=fetch /out/bin/ /usr/local/bin/
COPY --from=fetch --chown=stf:stf /out/bundletool/ /opt/bundletool/

WORKDIR /opt

# Export default app port
EXPOSE 3000

# Switch to the app user.
USER stf
##Use root user only for debug
#USER root

# Show help by default.
CMD stf --help
