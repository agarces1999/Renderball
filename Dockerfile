# Renderball — single always-on container: Next.js app + Remotion render.
# The render path runs headless Chromium; Remotion ships its own ffmpeg via the
# Linux compositor binaries that `npm ci` installs in-image.
FROM node:20-bookworm-slim

# System libraries headless Chromium needs (Remotion + Playwright) + fonts so
# rendered text isn't tofu. ffmpeg as belt-and-suspenders.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates wget gnupg \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 libatspi2.0-0 libgtk-3-0 libx11-xcb1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Keep the Playwright/Chromium download inside the image.
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.cache/ms-playwright

# Install exactly the lockfile (postinstall fetches Playwright Chromium).
COPY package.json package-lock.json ./
RUN npm ci

# Generate the Prisma client against the committed schema.
COPY prisma ./prisma
RUN npx prisma generate

# App source (see .dockerignore for what's excluded).
COPY . .

# NEXT_PUBLIC_* are inlined into the client bundle at build time, so they must
# be present here. Railway passes the service variable as a build arg.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
# Static, non-secret Clerk routing (our in-app branded /sign-in and /sign-up).
ENV NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in \
    NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up \
    NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/videos \
    NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/videos
ENV NODE_ENV=production

RUN npm run build

# Pre-fetch Remotion's Chrome Headless Shell so the first render isn't slow.
# Best-effort: if the CLI name drifts, Remotion fetches it at first render.
RUN npx remotion browser ensure || true

EXPOSE 3000
ENV PORT=3000
# Run pending Prisma migrations against DATABASE_URL before serving — the
# image previously only ran `prisma generate`, so schema changes (e.g. the
# ScriptDoc migration) never reached prod Neon via any automated path.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
