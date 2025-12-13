# syntax = docker/dockerfile:1

ARG NODE_VERSION=22.21.1
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

WORKDIR /app
ENV NODE_ENV="production"


# ---------- Build stage ----------
FROM base AS build

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
      build-essential \
      node-gyp \
      pkg-config \
      python-is-python3

COPY package.json ./
RUN npm install

COPY . .


# ---------- Final runtime stage ----------
FROM base

# 🔥 INSTALL FFMPEG HERE (THIS IS WHAT WAS MISSING)
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Copy built app
COPY --from=build /app /app

EXPOSE 3000
CMD [ "npm", "run", "start" ]
