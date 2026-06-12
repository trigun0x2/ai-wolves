# AI Werewolf Arena — single always-on container (Express + ws + static frontend).
FROM node:22-slim

WORKDIR /app

# Install all deps (vite + tsx are needed to build the frontend and run the server).
COPY package*.json ./
RUN npm ci

# App source + build the frontend into web-dist (served statically by Express).
COPY . .
RUN npm run build

ENV PORT=3000
EXPOSE 3000

# Runs `tsx src/server/index.ts` (ESM, top-level await for the store bootstrap).
CMD ["npm", "run", "start"]
