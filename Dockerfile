FROM oven/bun:latest

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json bun.lock ./
RUN bun install --no-save

# Copy source
COPY src/ src/
COPY tsconfig.json ./

EXPOSE 3001

CMD ["bun", "run", "src/index.ts"]
