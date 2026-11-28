# syntax=docker/dockerfile:1
# GongYuAI — TSecBench Hosted Official Competition Image (build with --platform linux/amd64)
# Runs Control Plane + Watchdog + 1 Leader + 3 Followers autonomously in offline sandbox.

FROM golang:1.26-bookworm AS netd-builder
WORKDIR /src/services/netd
COPY services/netd/go.mod services/netd/go.sum ./
RUN go mod download
COPY services/netd ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/gy-netd ./cmd/gy-netd

FROM node:22-bookworm-slim AS builder

WORKDIR /opt/gongyuai

RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/cli ./apps/cli
COPY apps/console/package.json ./apps/console/package.json

RUN pnpm install --frozen-lockfile \
  && pnpm --filter '!@gongyuai/console' run build

FROM kalilinux/kali-rolling AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    NEEDRESTART_MODE=a \
    TERM=xterm-256color \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    GY_TSEC_HOSTED=1 \
    GY_INSTALL_ROOT=/opt/gongyuai \
    GY_DATA_DIR=/task/gongyuai-data \
    GY_CONCURRENCY=3 \
    GY_TSEC_ALLOW_HINT=0 \
    NODE_ENV=production

# Copy Node.js 22.x runtime (with built-in node:sqlite) and cached pnpm from builder
COPY --from=builder /usr/local/bin/node /usr/local/bin/node
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /root/.cache/node/corepack /root/.cache/node/corepack

RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && ln -sf /usr/local/lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
  && corepack enable

# Offline pentest, intranet pivot, crypto, and reverse-engineering arsenal (no public internet in hosted sandbox)
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
    ca-certificates \
    ncurses-base \
    curl \
    wget \
    git \
    jq \
    unzip \
    zip \
    tar \
    gzip \
    bzip2 \
    xz-utils \
    file \
    lsof \
    procps \
    psmisc \
    iproute2 \
    iputils-ping \
    net-tools \
    dnsutils \
    netcat-openbsd \
    socat \
    openssh-client \
    sshpass \
    ftp \
    smbclient \
    proxychains4 \
    chisel \
    openssl \
    sqlite3 \
    default-mysql-client \
    postgresql-client \
    redis-tools \
    ldap-utils \
    tshark \
    nmap \
    masscan \
    sqlmap \
    ffuf \
    gobuster \
    httpx-toolkit \
    whatweb \
    nikto \
    dirb \
    hydra \
    john \
    radare2 \
    gdb \
    binutils \
    strace \
    ltrace \
    patchelf \
    binwalk \
    gcc \
    g++ \
    make \
    default-jdk-headless \
    python3 \
    python3-pip \
    python3-venv \
    python3-z3 \
    python3-unicorn \
    python3-capstone \
    python3-pwntools \
    python3-impacket \
    python3-pycryptodome \
    python3-cryptography \
    python3-requests \
    python3-httpx \
    python3-bs4 \
    python3-jwt \
    python3-paramiko \
    python3-yaml \
    python3-lxml \
    python3-pymysql \
    python3-psycopg2 \
    python3-redis \
    python3-ldap3 \
    python3-sympy \
  && pip3 install --no-cache-dir --break-system-packages pycryptodome \
  && ln -sf /usr/bin/httpx-toolkit /usr/local/bin/httpx \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /tmp/* /var/tmp/*

# Build r2ghidra (pdg pseudo-C decompiler for radare2) cleanly and strip build caches
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends libradare2-dev pkg-config cmake bison flex \
  && (r2pm -U && r2pm -ci r2ghidra || true) \
  && rm -rf /root/.local/share/radare2/r2pm/git /root/.local/share/radare2/r2pm/db \
  && apt-get purge -y -qq cmake bison flex \
  && apt-get autoremove -y -qq \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /opt/gongyuai

# Copy ONLY clean compiled GongYuAI runtime + built-in generic skills (zero task history / zero challenge memory)
COPY --from=builder /opt/gongyuai/package.json /opt/gongyuai/pnpm-workspace.yaml /opt/gongyuai/tsconfig.base.json ./
COPY --from=builder /opt/gongyuai/node_modules ./node_modules
COPY --from=builder /opt/gongyuai/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=builder /opt/gongyuai/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder /opt/gongyuai/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=builder /opt/gongyuai/packages/exec/package.json ./packages/exec/package.json
COPY --from=builder /opt/gongyuai/packages/exec/dist ./packages/exec/dist
COPY --from=builder /opt/gongyuai/packages/exec/node_modules ./packages/exec/node_modules
COPY --from=builder /opt/gongyuai/packages/history/package.json ./packages/history/package.json
COPY --from=builder /opt/gongyuai/packages/history/dist ./packages/history/dist
COPY --from=builder /opt/gongyuai/packages/history/node_modules ./packages/history/node_modules
COPY --from=builder /opt/gongyuai/packages/control-plane/package.json ./packages/control-plane/package.json
COPY --from=builder /opt/gongyuai/packages/control-plane/dist ./packages/control-plane/dist
COPY --from=builder /opt/gongyuai/packages/control-plane/node_modules ./packages/control-plane/node_modules
COPY --from=builder /opt/gongyuai/packages/worker/package.json ./packages/worker/package.json
COPY --from=builder /opt/gongyuai/packages/worker/dist ./packages/worker/dist
COPY --from=builder /opt/gongyuai/packages/worker/node_modules ./packages/worker/node_modules
COPY --from=builder /opt/gongyuai/apps/cli/package.json ./apps/cli/package.json
COPY --from=builder /opt/gongyuai/apps/cli/dist ./apps/cli/dist
COPY --from=builder /opt/gongyuai/apps/cli/node_modules ./apps/cli/node_modules
COPY --from=netd-builder /out/gy-netd ./bin/gy-netd

COPY mcp/builtin ./mcp/builtin
COPY skills/builtin ./skills/builtin
COPY skills/routing.json ./skills/routing.json
COPY scripts/tsecbench.ts ./scripts/tsecbench.ts
COPY examples/tsecbench/goals-autonomous.json ./examples/tsecbench/goals-autonomous.json
COPY docker/tsecbench/goals-hosted.json ./docker/tsecbench/goals-hosted.json
COPY docker/tsecbench/entrypoint.mjs ./docker/tsecbench/entrypoint.mjs

RUN chmod +x /opt/gongyuai/docker/tsecbench/entrypoint.mjs \
  && ln -sf /opt/gongyuai/docker/tsecbench/entrypoint.mjs /usr/local/bin/gy-tsecbench-hosted \
  && mkdir -p /task /task/gongyuai-data

WORKDIR /task
ENTRYPOINT ["node", "/opt/gongyuai/docker/tsecbench/entrypoint.mjs"]
