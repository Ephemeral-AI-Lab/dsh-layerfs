# The LayerFS runtime image Sandboxes and the macOS Store container run. It
# began as the #352 history replay's runtime image (that replay stays in the
# layerfs repository, dsh/tools/history/runtime at cea713e767); the image and
# its tag are unchanged.
#   docker build -t layerfs-352-runtime:node24 tools/runtime
# Node 24 satisfies every range's engines (ranges 0–9 need >=24; the rest
# ^22.19.0 || >=24.0.0). Corepack holds every package manager dsh's history
# names, prepared at build time, and the network is off for it at run time:
# range 0 yarn@4.14.1, ranges 1–187 pnpm@11.7.0, ranges 188–201 pnpm@11.28.5.
# Debian bookworm, as the LayerFS daemon's own build, and git, python3, gcc and
# make from the base for the tests that use them.
FROM node:24.21.0-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0

ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_AUTO_PIN=0

RUN corepack enable \
 && corepack install --global pnpm@11.28.5 \
 && corepack prepare pnpm@11.7.0 pnpm@11.28.5 yarn@4.14.1 \
 && chmod -R a+rX /opt/corepack

# from here on, corepack uses only what is prepared above
ENV COREPACK_ENABLE_NETWORK=0 \
    CI=1

LABEL org.opencontainers.image.title="layerfs-352-runtime" \
      org.opencontainers.image.description="Node 24 with pnpm 11.7.0, pnpm 11.28.5 and yarn 4.14.1 prepared offline, for the #352 history replay"

CMD ["bash"]
