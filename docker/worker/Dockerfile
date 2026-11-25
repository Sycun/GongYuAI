FROM kalilinux/kali-rolling

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
  && apt-get install -y -qq curl ca-certificates git python3 python3-pip \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y -qq nodejs \
  && pip3 install --no-cache-dir --break-system-packages "aimy-skill[mcp] @ git+https://github.com/Prohao42/aimy-skill.git" "mcp>=1.0.0,<2.0.0" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/gongyuai
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN corepack enable && corepack prepare pnpm@10.15.0 --activate \
  && pnpm install --frozen-lockfile=false \
  && pnpm -r run build

LABEL org.gongyuai.command-review="1"
WORKDIR /task
ENV GY_MANIFEST=/task/manifest.json
ENTRYPOINT ["node", "/opt/gongyuai/packages/worker/dist/main.js", "--manifest", "/task/manifest.json"]
