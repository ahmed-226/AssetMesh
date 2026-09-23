# ---- build stage — compile TypeScript so the runtime image needs no dev deps --
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
# sharp ships prebuilt libvips binaries (@img/sharp-linux-x64) as optional
# deps; on Debian-slim/glibc no native toolchain is needed at install time.
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage — production deps + compiled output only ----
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    STORAGE_DIR=/var/assetmesh/data \
    PORT=3000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# The image runs as an unprivileged user; give it the data mount point so
# uploads/renames (tmp/ then rename) work on the host-bound volume.
RUN mkdir -p /var/assetmesh/data && chown node:node /var/assetmesh/data
USER node

EXPOSE 3000
CMD ["node", "dist/main.js"]